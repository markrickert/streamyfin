package expo.modules.tvrecommendations

import android.content.Context
import android.graphics.BitmapFactory
import android.net.Uri
import java.io.File

internal object TvArtwork {
  private const val FOLDER = "tv_discovery_art"
  private const val MAX_FILES = 72
  private const val MAX_BYTES = 8 * 1024 * 1024L
  private const val MAX_STORAGE_BYTES = 48 * 1024 * 1024L
  private val namePattern = Regex("[a-f0-9]{64}\\.jpg")

  private fun directory(context: Context) = File(context.filesDir, FOLDER)

  private fun image(context: Context, key: String): File? {
    if (!namePattern.matches("$key.jpg")) return null
    return File(directory(context), "$key.jpg")
  }

  private fun contentUri(context: Context, file: File): Uri =
    Uri.Builder()
      .scheme("content")
      .authority("${context.packageName}.tvrecommendations.artwork")
      .appendPath(file.name)
      .build()

  fun fileForUri(context: Context, uri: Uri): File? {
    if (uri.scheme != "content" ||
        uri.authority != "${context.packageName}.tvrecommendations.artwork" ||
        uri.pathSegments.size != 1) return null
    val filename = uri.lastPathSegment ?: return null
    if (!namePattern.matches(filename)) return null
    return File(directory(context), filename).takeIf { it.isFile }
  }

  fun isReadableReference(context: Context, reference: String): Boolean =
    fileForUri(context, Uri.parse(reference)) != null

  fun getCached(context: Context, key: String): String? {
    val file = image(context, key) ?: return null
    return if (file.isFile) contentUri(context, file).toString() else null
  }

  fun store(context: Context, key: String, fileUri: String): String? {
    getCached(context, key)?.let { return it }
    val target = image(context, key) ?: return null
    val sourceUri = Uri.parse(fileUri)
    if (sourceUri.scheme != "file") return null
    val source = File(sourceUri.path ?: return null)
    if (!source.isFile || source.length() == 0L || source.length() > MAX_BYTES) return null
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeFile(source.path, bounds)
    if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null
    val folder = directory(context)
    if (!folder.exists() && !folder.mkdirs()) return null
    val files = folder.listFiles() ?: return null
    if (files.size >= MAX_FILES || files.sumOf { it.length() } + source.length() > MAX_STORAGE_BYTES) return null
    val temporary = File(folder, "$key.pending")
    return try {
      source.copyTo(temporary)
      if (!temporary.renameTo(target)) return null
      contentUri(context, target).toString()
    } catch (_: Exception) {
      null
    } finally {
      temporary.delete()
    }
  }

  fun prune(context: Context, keys: List<String>) {
    val keep = keys.mapNotNull { image(context, it)?.name }.toSet()
    directory(context).listFiles()?.forEach { file ->
      if (file.name !in keep) file.delete()
    }
  }

  fun clear(context: Context) {
    directory(context).deleteRecursively()
  }
}
