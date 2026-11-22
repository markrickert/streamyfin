import { pluginLines } from "./lintProbes";

const FLAGGED = [
  'a: { color: "#fff" }',
  'a: { color: "#FFFFFF80" }',
  'a: { backgroundColor: "rgba(0, 0, 0, 0.5)" }',
  'a: { borderColor: "rgb(1,2,3)" }',
  'a: { color: "white" }',
  'a: { backgroundColor: "black" }',
  'a: { color: "tomato" }',
  "a: <X tintColor='silver' />",
  "a: { shadowColor: 'red' }",
  "a: <X color='#fff' />",
  "a: <X tintColor='white' />",
  "a: <X backgroundColor='black' />",
  "a: <X className='bg-neutral-900' />",
  "a: <X className='flex text-red-500 p-2' />",
  "a: <X className='bg-[#121212]' />",
  "a: <X className='border-t-purple-600' />",
  "a: `p-2 text-gray-400`",
];

const ALLOWED = [
  "a: { color: Colors.foreground }",
  "a: { backgroundColor: Colors.transparent }",
  'a: { backgroundColor: "transparent" }',
  "a: <X fill='none' />",
  'a: { stroke: "currentColor" }',
  'a: { alignItems: "center" }',
  'a: { name: "white" }',
  "a: <X color='purple' />",
  "a: <Button color='white' />",
  "a: <X className='bg-surface text-foreground-muted' />",
  "a: <X className='bg-white/10 border-primary-dark' />",
  "a: <X className='text-white' />",
  "a: <X className='bg-black/60 bg-transparent' />",
  "a: <X className='rounded-lg border-2' />",
  'a: "#hashtag is not a color"',
];

// One case per line, so a diagnostic's line number names its case. The probe
// sits under components/ for the biome.json override that wires the plugin up
// to apply.
const lintedLines = (cases: string[]): number[] =>
  pluginLines([
    {
      dir: "components",
      name: "Probe.tsx",
      content: `export const a = [\n${cases
        .map((c) => `  ${c.replace(/^a: /, "")},`)
        .join("\n")}\n];\n`,
    },
  ])["Probe.tsx"].map((line) => line - 1);

describe("no-color-literal", () => {
  const all = [...FLAGGED, ...ALLOWED];
  const lines = lintedLines(all);

  it.each(FLAGGED)("flags %s", (source) => {
    expect(lines).toContain(all.indexOf(source) + 1);
  });

  it.each(ALLOWED)("allows %s", (source) => {
    expect(lines).not.toContain(all.indexOf(source) + 1);
  });
});
