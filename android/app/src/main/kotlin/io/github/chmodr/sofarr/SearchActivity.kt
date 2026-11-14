package io.github.chmodr.sofarr

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.LocalBringIntoViewSpec
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.tv.material3.Text
import kotlinx.coroutines.delay

/** Search movies and shows (the web's Search): on-screen keyboard on the left, results on the right. */
class SearchActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val api = Sofarr.api(this) ?: return finish()
        setContent { SofarrTheme { SearchScreen(api, onBack = ::finish) } }
    }
}

private const val DEBOUNCE_MS = 350L
private val KEYS = "abcdefghijklmnopqrstuvwxyz1234567890".map { it.toString() }

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun SearchScreen(api: SofarrApi, onBack: () -> Unit) {
    val context = LocalContext.current
    var query by remember { mutableStateOf("") }
    var results by remember { mutableStateOf<List<RowItem>?>(null) }
    var loading by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val cache = remember { mutableMapOf<String, List<RowItem>>() }
    val firstKey = remember { FocusRequester() }
    val open = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) {
        // Statuses may have changed (a request from the title page): drop what we had.
        cache.clear()
        results = null // runs the search again
    }

    fun type(s: String) { query = (query + s).take(100) }

    LaunchedEffect(Unit) {
        delay(50)
        runCatching { firstKey.requestFocus() }
    }

    // Debounced search.
    LaunchedEffect(query, results == null) {
        val q = query.trim()
        if (q.length < 2) {
            results = null
            error = null
            loading = false
            return@LaunchedEffect
        }
        cache[q]?.let {
            results = it
            return@LaunchedEffect
        }
        loading = true
        delay(DEBOUNCE_MS)
        try {
            val r = api.search(q)
            cache[q] = r
            results = r
            error = null
        } catch (e: Exception) {
            error = "Search isn't available right now."
        } finally {
            loading = false
        }
    }

    // Back deletes what's typed first, like Backspace on the web.
    BackHandler(enabled = query.isNotEmpty()) { query = query.dropLast(1) }

    Row(Modifier.fillMaxSize().padding(start = Tokens.Gutter, end = Tokens.Gutter, top = 15.dp), horizontalArrangement = Arrangement.spacedBy(20.dp)) {
        // .search-side
        Column(Modifier.width(250.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Brand()
            Box(
                Modifier.fillMaxWidth().clip(RoundedCornerShape(Tokens.Radius)).background(Tokens.BgRaised)
                    .padding(horizontal = 10.dp, vertical = 7.5.dp),
            ) {
                Text(
                    query.ifEmpty { "Search movies and shows" },
                    color = if (query.isEmpty()) Tokens.Muted else Tokens.Text,
                    fontSize = 13.sp, maxLines = 1, overflow = TextOverflow.StartEllipsis,
                )
            }
            // .kbd: six across; Space / Delete / Clear take two each.
            val rows = KEYS.chunked(6)
            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                rows.forEachIndexed { r, keys ->
                    Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                        keys.forEachIndexed { c, k ->
                            Key(k.uppercase(), { type(k) }, Modifier.weight(1f).then(if (r == 0 && c == 0) Modifier.focusRequester(firstKey) else Modifier))
                        }
                    }
                }
                Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                    Key("Space", { type(" ") }, Modifier.weight(1f), small = true)
                    Key("Delete", { query = query.dropLast(1) }, Modifier.weight(1f), small = true)
                    Key("Clear", { query = "" }, Modifier.weight(1f), small = true)
                }
            }
            SofarrButton("← Back", onBack, kind = ButtonKind.Quiet)
        }

        // .search-results
        Box(Modifier.weight(1f).fillMaxSize()) {
            val q = query.trim()
            val list = results
            when {
                q.length < 2 -> Hint("Type at least two letters.")
                error != null -> Hint(error!!, Tokens.Error)
                list == null || (loading && list.isEmpty()) -> ResultsGrid(api, null, onOpen = {})
                list.isEmpty() -> Hint("Nothing found for “$q”.")
                else -> {
                    val margin = with(LocalDensity.current) { 40.dp.toPx() }
                    CompositionLocalProvider(LocalBringIntoViewSpec provides remember(margin) { KeepVisible(margin) }) {
                        ResultsGrid(api, list, onOpen = { openItem(context, it, open::launch) })
                    }
                }
            }
        }
    }
}

@Composable
private fun Hint(text: String, color: Color = Tokens.Muted) =
    Text(text, color = color, fontSize = 10.sp, modifier = Modifier.padding(top = 42.dp))

@Composable
private fun Key(label: String, onClick: () -> Unit, modifier: Modifier, small: Boolean = false) {
    FocusBox(onClick, modifier) { focused ->
        Box(
            Modifier.fillMaxWidth().background(if (focused) Tokens.Text else Color.White.copy(alpha = 0.12f)).padding(vertical = 5.5.dp),
            contentAlignment = Alignment.Center,
        ) {
            Text(label, color = if (focused) Tokens.Bg else Tokens.Text, fontSize = if (small) 9.sp else 10.5.sp, fontWeight = FontWeight.SemiBold)
        }
    }
}

/** .results-grid: three across in the space beside the keyboard; placeholders while loading. */
@Composable
private fun ResultsGrid(api: SofarrApi, items: List<RowItem>?, onOpen: (RowItem) -> Unit) {
    val columns = 3
    val rows = items?.chunked(columns) ?: List(3) { emptyList() }
    LazyColumn(contentPadding = PaddingValues(top = 40.dp, bottom = 30.dp, start = 6.dp, end = 6.dp), verticalArrangement = Arrangement.spacedBy(11.dp)) {
        items(rows.size) { i ->
            Row(horizontalArrangement = Arrangement.spacedBy(9.dp)) {
                if (items == null) {
                    repeat(columns) { Box(Modifier.weight(1f).aspectRatio(16f / 9f).clip(RoundedCornerShape(Tokens.CardRadius)).background(Tokens.BgHover)) }
                } else {
                    rows[i].forEach { t ->
                        Box(Modifier.weight(1f)) {
                            TitleCard(t, (t.backdrop ?: t.poster)?.let(api::resolve), onClick = { onOpen(t) }, showYear = true,
                                width = 200.dp, modifier = Modifier.fillMaxWidth())
                        }
                    }
                    repeat(columns - rows[i].size) { Spacer(Modifier.weight(1f)) }
                }
            }
        }
    }
}

/** The header's magnifier (`SearchIcon` on the web). */
@Composable
fun SearchIcon(color: Color, size: Dp = 15.dp) {
    Canvas(Modifier.size(size)) {
        val w = this.size.width
        val stroke = w * 0.13f
        drawCircle(color, radius = w * 0.3f, center = Offset(w * 0.42f, w * 0.42f), style = Stroke(stroke))
        drawLine(color, Offset(w * 0.64f, w * 0.64f), Offset(w * 0.9f, w * 0.9f), strokeWidth = stroke, cap = StrokeCap.Round)
    }
}
