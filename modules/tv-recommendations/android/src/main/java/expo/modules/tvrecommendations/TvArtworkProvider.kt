package expo.modules.tvrecommendations

import android.content.ContentProvider
import android.content.ContentValues
import android.database.Cursor
import android.database.MatrixCursor
import android.net.Uri
import android.os.ParcelFileDescriptor
import android.provider.OpenableColumns
import java.io.File
import java.io.FileNotFoundException

/** The TV launcher reads these already-published posters without seeing server credentials. */
class TvArtworkProvider : ContentProvider() {
  private val artworkName = Regex("^[a-f0-9]{64}\\.jpg$")

  override fun onCreate(): Boolean = true

  private fun imageFile(uri: Uri): File {
    val name = uri.pathSegments.singleOrNull()
    if (name == null || !artworkName.matches(name)) throw FileNotFoundException()
    return File(File(requireNotNull(context).filesDir, "tv-discovery-images"), name)
  }

  override fun getType(uri: Uri): String? {
    imageFile(uri)
    return "image/jpeg"
  }

  override fun openFile(uri: Uri, mode: String): ParcelFileDescriptor {
    if (mode != "r") throw FileNotFoundException()
    return ParcelFileDescriptor.open(imageFile(uri), ParcelFileDescriptor.MODE_READ_ONLY)
  }

  override fun query(
    uri: Uri,
    projection: Array<out String>?,
    selection: String?,
    selectionArgs: Array<out String>?,
    sortOrder: String?
  ): Cursor {
    val file = imageFile(uri)
    val columns = projection ?: arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE)
    return MatrixCursor(columns).apply {
      addRow(columns.map {
        when (it) {
          OpenableColumns.DISPLAY_NAME -> file.name
          OpenableColumns.SIZE -> file.length()
          else -> null
        }
      })
    }
  }

  override fun insert(uri: Uri, values: ContentValues?): Uri? =
    throw UnsupportedOperationException()

  override fun update(
    uri: Uri,
    values: ContentValues?,
    selection: String?,
    selectionArgs: Array<out String>?
  ): Int = throw UnsupportedOperationException()

  override fun delete(
    uri: Uri,
    selection: String?,
    selectionArgs: Array<out String>?
  ): Int = throw UnsupportedOperationException()
}
