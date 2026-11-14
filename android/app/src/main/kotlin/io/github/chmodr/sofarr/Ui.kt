package io.github.chmodr.sofarr

import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.BringIntoViewSpec
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.tv.material3.Text
import kotlinx.coroutines.delay

/*
 * Sofarr's look, carried over from the web UI (web/src/styles/app.css).
 * The web sizes everything in rem with the root at ~1.05vw: on a 1080p TV, 1 rem is
 * about 10 dp of Android TV's 960 x 540 dp screen. So "1.3rem" there is 13 here.
 */
object Tokens {
    val Bg = Color(0xFF0E0F13)
    val BgRaised = Color(0xFF191B22)
    val BgHover = Color(0xFF23262F)
    val Text = Color(0xFFF1F1F3)
    val Muted = Color(0xFFA3A6B1)
    val Accent = Color(0xFFF0A640)
    val AccentFocused = Color(0xFFFFC46B)
    val AccentInk = Color(0xFF1A1206)
    val Ok = Color(0xFF57C78A)
    val Info = Color(0xFF6AA8FF)
    val Warn = Color(0xFFE7C35A)
    val Overview = Color(0xFFD6D7DC)
    val Sub = Color(0xFFD0D2D8)
    val Error = Color(0xFFFF8A80)

    val Gutter = 38.dp // clamp(1rem, 4vw, 4rem)
    val CardWidth = 182.dp // clamp(11rem, 19vw, 19rem)
    val CardRadius = 3.dp // 0.28rem: artwork gets tighter corners than buttons and panels
    val Radius = 5.dp // 0.5rem
}

/** Focus ring: a 2 dp gap in the page colour, then 2 dp of accent (the web's `--focus`). */
fun Modifier.focusRing(focused: Boolean, radius: Dp, gap: Color = Tokens.Bg): Modifier = drawWithContent {
    drawContent()
    if (!focused) return@drawWithContent
    val w = 2.dp.toPx()
    fun ring(outset: Float, color: Color) = drawRoundRect(
        color = color,
        topLeft = Offset(-outset, -outset),
        size = Size(size.width + 2 * outset, size.height + 2 * outset),
        cornerRadius = CornerRadius(radius.toPx() + outset),
        style = Stroke(w),
    )
    ring(w / 2, gap)
    ring(w * 1.5f, Tokens.Accent)
}

/**
 * Anything you can select with the remote: scales up and gets the focus ring when
 * focused, like the web's `.is-focused`.
 */
@Composable
fun FocusBox(
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    shape: Shape = RoundedCornerShape(Tokens.Radius),
    radius: Dp = Tokens.Radius,
    focusedScale: Float = 1.05f,
    ring: Boolean = true,
    shadow: Boolean = false,
    enabled: Boolean = true,
    onFocus: () -> Unit = {},
    content: @Composable BoxScope.(focused: Boolean) -> Unit,
) {
    var focused by remember { mutableStateOf(false) }
    val scale by animateFloatAsState(if (focused) focusedScale else 1f, tween(140), label = "focus-scale")
    val source = remember { MutableInteractionSource() }
    Box(
        modifier
            .onFocusChanged {
                focused = it.isFocused
                if (it.isFocused) onFocus()
            }
            .graphicsLayer { scaleX = scale; scaleY = scale }
            // clip = false: the focus ring is drawn outside the shape.
            .then(if (shadow && focused) Modifier.shadow(16.dp, shape, clip = false) else Modifier)
            .focusRing(focused && ring, radius)
            .clip(shape)
            .clickable(interactionSource = source, indication = null, enabled = enabled, onClick = onClick),
    ) { content(focused) }
}

enum class ButtonKind { Default, Primary, Quiet }

/** `.btn`, `.btn-primary`, `.btn-quiet`. */
@Composable
fun SofarrButton(
    text: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    kind: ButtonKind = ButtonKind.Default,
    enabled: Boolean = true,
    small: Boolean = false,
    onFocus: () -> Unit = {},
) {
    FocusBox(onClick = { if (enabled) onClick() }, modifier = modifier, onFocus = onFocus) { focused ->
        val (bg, fg) = when {
            focused && kind == ButtonKind.Primary -> Tokens.AccentFocused to Tokens.AccentInk
            focused -> Tokens.Text to Tokens.Bg
            kind == ButtonKind.Primary -> Tokens.Accent to Tokens.AccentInk
            kind == ButtonKind.Quiet -> Color.Transparent to Tokens.Text
            else -> Color.White.copy(alpha = 0.12f) to Tokens.Text
        }
        Text(
            text,
            color = fg,
            fontSize = 10.sp,
            fontWeight = FontWeight.SemiBold,
            modifier = Modifier
                .background(bg)
                .graphicsLayer { alpha = if (enabled) 1f else 0.45f }
                .padding(horizontal = if (small) 11.dp else 14.dp, vertical = if (small) 5.dp else 7.dp),
        )
    }
}

/** Pill-shaped tab (season tabs): current one tinted, focused one inverted. */
@Composable
fun TabButton(text: String, current: Boolean, onClick: () -> Unit, modifier: Modifier = Modifier, onFocus: () -> Unit = {}) {
    FocusBox(onClick, modifier, shape = RoundedCornerShape(50), radius = 50.dp, onFocus = onFocus) { focused ->
        Text(
            text,
            color = if (focused) Tokens.Bg else if (current) Tokens.Text else Tokens.Muted,
            fontSize = 10.sp,
            fontWeight = FontWeight.SemiBold,
            maxLines = 1,
            modifier = Modifier
                .background(if (focused) Tokens.Text else if (current) Color.White.copy(alpha = 0.14f) else Color.Transparent)
                .padding(horizontal = 12.dp, vertical = 5.5.dp),
        )
    }
}

/** Status pill (`.pill-<status>`). */
@Composable
fun StatusPill(status: String, label: String) {
    val (bg, fg) = when (status) {
        "owned" -> Tokens.Ok.copy(alpha = 0.2f) to Tokens.Ok
        "downloading" -> Tokens.Info.copy(alpha = 0.2f) to Tokens.Info
        "requested", "upcoming" -> Tokens.Warn.copy(alpha = 0.18f) to Tokens.Warn
        "available" -> Tokens.Accent.copy(alpha = 0.2f) to Tokens.Accent
        else -> Color.White.copy(alpha = 0.14f) to Tokens.Text
    }
    Text(
        label,
        color = fg,
        fontSize = 8.5.sp,
        fontWeight = FontWeight.SemiBold,
        maxLines = 1,
        modifier = Modifier.clip(RoundedCornerShape(50)).background(bg).padding(horizontal = 7.dp, vertical = 1.5.dp),
    )
}

/** `.hero-meta`: muted, semi-bold, separated by space. */
@Composable
fun MetaRow(content: @Composable RowScope.() -> Unit) {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = androidx.compose.foundation.layout.Arrangement.spacedBy(10.dp),
        content = content,
    )
}

@Composable
fun MetaText(text: String) = Text(text, color = Tokens.Muted, fontSize = 10.sp, fontWeight = FontWeight.SemiBold, maxLines = 1)

/** Age rating, boxed as on a poster (`.cert`). */
@Composable
fun Cert(text: String) = Text(
    text,
    color = Tokens.Muted,
    fontSize = 8.5.sp,
    fontWeight = FontWeight.SemiBold,
    modifier = Modifier.border(1.dp, Tokens.Muted, RoundedCornerShape(2.dp)).padding(horizontal = 4.dp),
)

/** Thin progress bar: resume (accent) or download (info). */
@Composable
fun ProgressBar(percent: Float, color: Color, modifier: Modifier, track: Color = Color.White.copy(alpha = 0.25f)) {
    Box(modifier.background(track)) {
        Box(Modifier.fillMaxHeight().fillMaxWidth((percent / 100f).coerceIn(0.02f, 1f)).background(color))
    }
}

/** `.toast`: a message at the bottom centre that goes away by itself. */
@Composable
fun BoxScope.Toast(message: String?, onDone: () -> Unit) {
    if (message == null) return
    LaunchedEffect(message) {
        delay(8_000)
        onDone()
    }
    Text(
        message,
        color = Tokens.Text,
        fontSize = 10.sp,
        fontWeight = FontWeight.SemiBold,
        modifier = Modifier
            .align(Alignment.BottomCenter)
            .padding(bottom = 20.dp)
            .widthIn(max = 440.dp)
            .shadow(20.dp, RoundedCornerShape(Tokens.Radius))
            .clip(RoundedCornerShape(Tokens.Radius))
            .background(Color(0xF7191B22))
            .border(1.dp, Color.White.copy(alpha = 0.12f), RoundedCornerShape(Tokens.Radius))
            .padding(horizontal = 13.dp, vertical = 8.dp),
    )
}

/**
 * Remote navigation like the web's rows: whatever gets focus is scrolled to `leading`
 * from the start of its list, so the selection stays in one place and the content moves.
 */
@OptIn(ExperimentalFoundationApi::class)
class PinToStart(private val leadingPx: Float) : BringIntoViewSpec {
    override fun calculateScrollDistance(offset: Float, size: Float, containerSize: Float): Float = offset - leadingPx
}

/**
 * Like a web page: scroll only as far as needed to show what got focus (with a margin).
 * Compose's default on TV moves the focused item to about a third of the way down.
 */
@OptIn(ExperimentalFoundationApi::class)
class KeepVisible(private val marginPx: Float, private val topInsetPx: Float = 0f) : BringIntoViewSpec {
    // `topInsetPx`: the part of the list covered by something drawn over it (a header).
    override fun calculateScrollDistance(offset: Float, size: Float, containerSize: Float): Float {
        val end = offset + size
        return when {
            offset >= topInsetPx && end <= containerSize -> 0f
            offset < topInsetPx || size + 2 * marginPx > containerSize - topInsetPx -> offset - topInsetPx - marginPx
            else -> end - containerSize + marginPx
        }
    }
}

/** "2026-11-17" -> "Nov 17" (adds the year when it isn't this year), as the web's shortDate. */
fun shortDate(iso: String): String {
    val parts = iso.take(10).split("-").mapNotNull { it.toIntOrNull() }
    if (parts.size != 3) return iso
    val (y, m, d) = parts
    val months = listOf("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")
    val base = "${months.getOrElse(m - 1) { "?" }} $d"
    return if (y == java.time.LocalDate.now().year) base else "$base, $y"
}

fun runtime(min: Int?): String? {
    if (min == null || min <= 0) return null
    val h = min / 60
    return if (h > 0) "${h}h ${min % 60}m" else "${min}m"
}

/** *arr "[d.]hh:mm:ss" -> "2h 5m" / "12m" / "<1m". */
private fun timeLeft(t: String?): String? {
    if (t == null) return null
    val (days, rest) = if ('.' in t) t.split(".", limit = 2).let { it[0] to it[1] } else ("0" to t)
    val hms = rest.split(":").map { it.toIntOrNull() ?: 0 } + listOf(0, 0, 0)
    val total = (days.toIntOrNull() ?: 0) * 24 * 60 + hms[0] * 60 + hms[1]
    if (total <= 0) return if (hms[2] > 0) "<1m" else null
    val hh = total / 60
    return if (hh > 0) "${hh}h ${total % 60}m" else "${total}m"
}

private fun speed(bps: Double?): String? {
    if (bps == null || bps < 1024) return null
    return if (bps >= 1_000_000) "%.1f MB/s".format(bps / 1_000_000) else "${(bps / 1000).toInt()} KB/s"
}

fun downloadLabel(d: Download): String {
    val pct = "${d.percent.toInt()}%"
    return when (d.state) {
        "importPending", "importing" -> "Importing…"
        "waitingForPlex" -> "Almost ready"
        "downloading" -> listOfNotNull(pct, timeLeft(d.timeLeft)?.let { "$it left" }, speed(d.speedBps)).joinToString(" · ")
        "stalled" -> "$pct · waiting for peers"
        "queued" -> "$pct · queued"
        "paused" -> "$pct · paused"
        else -> if (d.percent > 0) pct else "Queued"
    }
}

/** The web's statusLabel. */
fun statusLabel(status: String, availableFrom: String?, download: Download?): String = when (status) {
    "owned" -> "Ready to watch"
    "downloading" -> download?.let(::downloadLabel) ?: "Downloading"
    "requested" -> availableFrom?.let { "Requested · coming ${shortDate(it)}" } ?: "Requested · searching"
    "upcoming" -> availableFrom?.let { "Coming ${shortDate(it)}" } ?: "Not out yet"
    else -> "Get it"
}

/** Row artwork is card-sized; the hero and the title page want the same image larger. */
fun largeBackdrop(url: String?): String? = url?.replace("/w780/", "/w1280/")?.replace("&w=780&h=439", "&w=1280&h=720")

val TitleStyle = TextStyle(fontWeight = FontWeight.ExtraBold, lineHeight = 1.05.em(), color = Tokens.Text)

private fun Double.em(): TextUnit = androidx.compose.ui.unit.TextUnit(this.toFloat(), androidx.compose.ui.unit.TextUnitType.Em)
