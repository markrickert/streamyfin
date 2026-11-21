import ts from "typescript";

const imagePath = /\/(?:Items|Users)\/[\s\S]{0,200}\/Images\//i;
const imageQuery =
  /[?&](?:fillWidth|fillHeight)=|[?&]maxWidth=[^&]+&maxHeight=/i;
const imageParameters = /\b(?:fillWidth|fillHeight)\b/;
const boundedImageParameters =
  /\bmaxWidth\b[\s\S]{0,150}\bmaxHeight\b|\bmaxHeight\b[\s\S]{0,150}\bmaxWidth\b/;
const imageUrlMethods = new Set([
  "getItemImageUrl",
  "getItemImageUrlById",
  "getUserImageUrlById",
]);

export function imageUrlViolations(
  source: string,
  filename: string,
): Array<{ line: number; message: string }> {
  if (
    filename.startsWith("utils/jellyfin/image/") ||
    filename.startsWith("scripts/") ||
    /\.(?:test|spec|perf-test)\.[jt]sx?$/.test(filename) ||
    /\/src\/(?:test|androidTest)\//.test(filename) ||
    /Tests\.swift$/.test(filename)
  ) {
    return [];
  }

  const file = ts.createSourceFile(
    filename,
    source,
    ts.ScriptTarget.Latest,
    true,
    filename.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const violations = new Map<number, string>();
  const visit = (node: ts.Node): void => {
    let message: string | undefined;
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateExpression(node) ||
      ts.isBinaryExpression(node) ||
      ts.isCallExpression(node) ||
      ts.isNewExpression(node)
    ) {
      const text = node.getText(file);
      if (imagePath.test(text)) {
        message =
          "Jellyfin image path must be created in utils/jellyfin/image/";
      } else if (
        (ts.isStringLiteral(node) ||
          ts.isNoSubstitutionTemplateLiteral(node) ||
          ts.isTemplateExpression(node)) &&
        imageQuery.test(text)
      ) {
        message =
          "Image size parameters must be built in utils/jellyfin/image/";
      }
    }
    if (ts.isNewExpression(node)) {
      const expression = node.expression.getText(file);
      if (expression === "ImageUrlsApi") {
        message = "SDK image URL builders belong in utils/jellyfin/image/";
      } else if (
        expression === "URLSearchParams" &&
        node.arguments?.some((argument) => {
          const text = argument.getText(file);
          return (
            imageParameters.test(text) || boundedImageParameters.test(text)
          );
        })
      ) {
        message =
          "Image size parameters must be built in utils/jellyfin/image/";
      }
    }
    if (ts.isCallExpression(node)) {
      if (
        ts.isIdentifier(node.expression) &&
        node.expression.text === "getImageApi"
      ) {
        message = "SDK image URL builders belong in utils/jellyfin/image/";
      }
      if (ts.isPropertyAccessExpression(node.expression)) {
        const method = node.expression.name.text;
        if (imageUrlMethods.has(method) || method === "getUserImageUrl") {
          message = "SDK image URL builders belong in utils/jellyfin/image/";
        }
        const owner = node.expression.expression;
        if (
          method === "join" &&
          ts.isArrayLiteralExpression(owner) &&
          owner.elements.some(
            (element) =>
              ts.isStringLiteral(element) &&
              /^(?:Items|Users)$/.test(element.text),
          ) &&
          owner.elements.some(
            (element) =>
              ts.isStringLiteral(element) && element.text === "Images",
          )
        ) {
          message =
            "Jellyfin image path must be created in utils/jellyfin/image/";
        }
      }
    }
    if (message) {
      const line =
        file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
      if (!violations.has(line)) violations.set(line, message);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return [...violations]
    .sort(([a], [b]) => a - b)
    .map(([line, message]) => ({
      line,
      message,
    }));
}
