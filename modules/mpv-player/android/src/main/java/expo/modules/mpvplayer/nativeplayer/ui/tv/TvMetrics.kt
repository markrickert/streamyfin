package expo.modules.mpvplayer.nativeplayer.ui.tv

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.unit.dp
import expo.modules.mpvplayer.Colors

/**
 * The chrome's shared palette. Every floating surface uses the same glass
 * recipe (translucent fill + hairline + sheen, see Modifier.tvGlass) and
 * every piece of content the same white ramp — per-component grays are what
 * made the chrome read as flat, mismatched stickers.
 */
object TvPalette {
    /** Fill for surfaces over video — translucent so the film bleeds through. */
    val SurfaceGlass = Colors.black50

    /** Fill for surfaces that need text legibility (menus, cards, pills). */
    val SurfaceGlassStrong = Colors.black80

    /** 1dp edge catch-light on every glass surface. */
    val Hairline = Colors.white10

    /** Top of the faux top-light gradient on larger surfaces. */
    val SheenTop = Colors.white10

    val OnSurface = Colors.white
    val OnSurfaceDim = Colors.white80
    val OnSurfaceFaint = Colors.white50

    /** Focus is always white fill with black content. */
    val FocusFill = Colors.white
    val OnFocus = Colors.black

    /** Unfocused row/chip fill when already sitting on a glass panel. */
    val RowFill = Colors.white05
}

/**
 * The one surface treatment for everything floating over video: translucent
 * fill, faint top sheen, hairline edge. Apply through this modifier only, so
 * the look cannot drift per component.
 */
fun Modifier.tvGlass(
    shape: Shape,
    strong: Boolean = false,
    sheen: Boolean = true
): Modifier {
    val base = this
        .clip(shape)
        .background(if (strong) TvPalette.SurfaceGlassStrong else TvPalette.SurfaceGlass)
    val lit = if (sheen) {
        base.background(
            Brush.verticalGradient(
                0f to TvPalette.SheenTop,
                0.45f to Colors.transparent
            )
        )
    } else {
        base
    }
    return lit.border(1.dp, TvPalette.Hairline, shape)
}

object TvMetrics {
    val INSET_H = 48.dp
    val INSET_V = 27.dp
    val FLOATING_BOTTOM_INSET = 47.dp

    val POSTER_WIDTH = 300.dp
    val POSTER_HEIGHT = 168.dp
    val POSTER_CORNER = 12.dp

    /** One diameter for every round control, one glyph size inside it. */
    val CONTROL_SIZE = 48.dp
    val ICON_SIZE = 22.dp
    val RADIUS_PANEL = 18.dp

    val SCRIM_HEIGHT = 110.dp
    val TEXT_INSET_H = 14.dp
    val TEXT_INSET_V = 12.dp
}

@Composable
fun TvPosterScrim(modifier: Modifier = Modifier) {
    Box(
        modifier = modifier
            .fillMaxWidth()
            .height(TvMetrics.SCRIM_HEIGHT)
            .background(
                Brush.verticalGradient(
                    colors = listOf(
                        Colors.transparent,
                        Colors.black60,
                        Colors.black80
                    )
                )
            )
    )
}
