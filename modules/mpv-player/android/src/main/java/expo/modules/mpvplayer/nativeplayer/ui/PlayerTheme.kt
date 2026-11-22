package expo.modules.mpvplayer.nativeplayer.ui

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import expo.modules.mpvplayer.Colors

val PlayerDarkScrim = Colors.black60
val PlayerPillBackground = Colors.black50
// Streamyfin primary purple — keep in sync with constants/Colors.ts `primary`.
val PlayerAccentColor = Colors.primary
val PlayerTrackBackground = Colors.white30
val PlayerBufferTrack = Colors.white50
val PlayerProgressTrack = Colors.white

private val DarkColorScheme = darkColorScheme(
    primary = Colors.white,
    secondary = PlayerAccentColor,
    background = Colors.black,
    surface = Colors.surface,
    onPrimary = Colors.black,
    onSecondary = Colors.white,
    onBackground = Colors.white,
    onSurface = Colors.white,
)

@Composable
fun PlayerTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = DarkColorScheme,
        content = content
    )
}
