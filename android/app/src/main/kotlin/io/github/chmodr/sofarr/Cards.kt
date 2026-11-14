package io.github.chmodr.sofarr

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import androidx.tv.material3.Text
import coil3.compose.AsyncImage

/** Small corner badge: only for titles you can't just play (the web's Badge). */
@Composable
private fun Badge(item: RowItem, modifier: Modifier) {
    val (text, fg, bg) = when (item.status) {
        "available" -> Triple("+", Tokens.AccentInk, Tokens.Accent)
        "requested" -> Triple(item.availableFrom?.let(::shortDate) ?: "Requested", Tokens.Warn, Color.Black.copy(alpha = 0.7f))
        "upcoming" -> Triple(item.availableFrom?.let(::shortDate) ?: "Soon", Tokens.Warn, Color.Black.copy(alpha = 0.7f))
        "downloading" -> Triple("↓", Tokens.Info, Color.Black.copy(alpha = 0.7f))
        else -> return
    }
    val big = item.status == "available"
    Text(
        text,
        color = fg,
        fontSize = if (big) 10.sp else 7.5.sp,
        fontWeight = FontWeight.Bold,
        lineHeight = if (big) 1.2.em else 1.4.em,
        modifier = modifier.clip(RoundedCornerShape(3.5.dp)).background(bg).padding(horizontal = if (big) 4.5.dp else 5.dp, vertical = if (big) 0.dp else 1.dp),
    )
}

/** The artwork part of a card: image, shade, title, ribbon, badge, progress. */
@Composable
private fun CardArt(item: RowItem, imageUrl: String?, showYear: Boolean) {
    Box(Modifier.fillMaxSize().background(Tokens.BgRaised)) {
        if (imageUrl != null) {
            AsyncImage(model = imageUrl, contentDescription = null, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize())
        } else {
            Box(Modifier.fillMaxSize().background(Brush.linearGradient(listOf(Color(0xFF2A2D38), Tokens.BgRaised))))
        }
        // .card-shade: dark at the bottom so the title reads over any artwork.
        Box(Modifier.fillMaxSize().background(Brush.verticalGradient(0.45f to Color.Transparent, 1f to Color.Black.copy(alpha = 0.85f))))
        Column(Modifier.align(Alignment.BottomStart).padding(start = 7.dp, end = 7.dp, bottom = 6.5.dp)) {
            val shadow = androidx.compose.ui.graphics.Shadow(Color.Black.copy(alpha = 0.7f), blurRadius = 4f)
            Text(item.title, fontSize = 9.5.sp, fontWeight = FontWeight.Bold, lineHeight = 1.2.em, maxLines = 2,
                overflow = TextOverflow.Ellipsis, style = TextStyle(shadow = shadow), color = Tokens.Text)
            val sub = item.resume?.label
                ?: if (showYear) listOfNotNull(item.year?.toString(), if (item.mediaType == "tv") "Series" else "Movie").joinToString(" · ") else null
            if (sub != null) {
                Text(sub, fontSize = 7.8.sp, fontWeight = FontWeight.Medium, color = Tokens.Sub, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }
        if (item.fresh != null && item.resume == null) {
            Text(
                if (item.fresh == "new") "NEW" else "NEW EPISODES",
                color = Tokens.AccentInk,
                fontSize = 7.2.sp,
                fontWeight = FontWeight.ExtraBold,
                letterSpacing = 0.02.em,
                modifier = Modifier.padding(top = 5.dp)
                    .clip(RoundedCornerShape(topEnd = 2.5.dp, bottomEnd = 2.5.dp))
                    .background(Tokens.Accent).padding(start = 5.dp, end = 5.5.dp, top = 1.2.dp, bottom = 1.2.dp),
            )
        }
        Badge(item, Modifier.align(Alignment.TopEnd).padding(5.dp))
        val progress = item.resume?.percent?.toFloat() ?: item.download?.percent?.toFloat()?.takeIf { item.status == "downloading" }
        if (progress != null) {
            ProgressBar(progress, if (item.resume != null) Tokens.Accent else Tokens.Info, Modifier.align(Alignment.BottomStart).fillMaxWidth().height(2.5.dp))
        }
    }
}

/**
 * A title card, as on the web: 16:9 artwork with the title over it. Top 10 rows put a
 * large outlined numeral behind the card's left edge.
 */
@Composable
fun TitleCard(
    item: RowItem,
    imageUrl: String?,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    width: Dp = Tokens.CardWidth,
    rank: Int? = null,
    showYear: Boolean = false,
    focusedScale: Float = 1.07f,
    onFocus: () -> Unit = {},
) {
    if (rank == null) {
        FocusBox(onClick, modifier.width(width).aspectRatio(16f / 9f), shape = RoundedCornerShape(Tokens.CardRadius),
            radius = Tokens.CardRadius, focusedScale = focusedScale, shadow = true, onFocus = onFocus) {
            CardArt(item, imageUrl, showYear)
        }
        return
    }
    var focused by remember { mutableStateOf(false) }
    Row(verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy((-15).dp)) {
        // .card-rank: page-coloured numeral with an outline that lights up with the card.
        val size = (width.value * 0.6f).sp
        Box {
            Text("$rank", fontSize = size, fontWeight = FontWeight.Black, lineHeight = 0.76.em, letterSpacing = (-0.07).em, color = Tokens.Bg,
                modifier = Modifier.offset(y = 6.dp))
            Text("$rank", fontSize = size, fontWeight = FontWeight.Black, lineHeight = 0.76.em, letterSpacing = (-0.07).em,
                color = if (focused) Tokens.Text else Color(0xFF7A7E8C),
                style = TextStyle(drawStyle = Stroke(width = 3.5f * 2)),
                modifier = Modifier.offset(y = 6.dp))
        }
        FocusBox(onClick, modifier.width(width).aspectRatio(16f / 9f).onFocusChanged { focused = it.isFocused },
            shape = RoundedCornerShape(Tokens.CardRadius), radius = Tokens.CardRadius, focusedScale = focusedScale,
            shadow = true, onFocus = onFocus) {
            CardArt(item, imageUrl, showYear)
        }
    }
}
