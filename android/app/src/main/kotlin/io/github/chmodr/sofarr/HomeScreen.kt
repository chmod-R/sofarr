package io.github.chmodr.sofarr

import android.content.Intent
import android.widget.Toast
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.tv.material3.Card
import androidx.tv.material3.MaterialTheme
import androidx.tv.material3.OutlinedButton
import androidx.tv.material3.Text
import coil3.compose.AsyncImage

/** Home: Sofarr's rows, with a header that follows the focused card. */
@Composable
fun HomeScreen(api: SofarrApi, onSwitchProfile: () -> Unit) {
    val context = LocalContext.current
    var rows by remember { mutableStateOf<List<Row>?>(null) }
    var message by remember { mutableStateOf<String?>(null) }
    var focused by remember { mutableStateOf<RowItem?>(null) }
    var reload by remember { mutableIntStateOf(0) }
    var wantFocus by remember { mutableStateOf(false) }
    val firstCard = remember { FocusRequester() }
    val player = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) { reload++ }

    LaunchedEffect(reload) {
        try {
            val firstLoad = rows == null
            rows = api.home().rows.filter { it.items.isNotEmpty() }
            message = null
            if (firstLoad) wantFocus = true
        } catch (e: Exception) {
            if (rows == null) message = "Couldn't load Home (${e.message ?: e.javaClass.simpleName})."
        }
    }

    fun open(item: RowItem) {
        val key = item.playKey
        if (key == null) {
            val what = when (item.status) {
                "downloading" -> "is downloading"
                "requested" -> "is requested"
                "upcoming" -> "isn't out yet"
                else -> "isn't in your library"
            }
            Toast.makeText(context, "${item.title} $what. Requesting from the TV is coming soon.", Toast.LENGTH_LONG).show()
            return
        }
        player.launch(Intent(context, PlayerActivity::class.java).putExtra(PlayerActivity.EXTRA_PLEX_KEY, key))
    }

    Box(Modifier.fillMaxSize()) {
        // Backdrop of the focused title, fading into the background.
        focused?.backdrop?.let { art ->
            AsyncImage(
                model = api.resolve(art),
                contentDescription = null,
                contentScale = ContentScale.Crop,
                modifier = Modifier.align(Alignment.TopEnd).fillMaxWidth(0.7f).aspectRatio(16f / 9f),
            )
            Box(
                Modifier.matchParentSize().background(
                    Brush.horizontalGradient(0.25f to Background, 0.6f to Background.copy(alpha = 0.55f), 1f to Color.Transparent),
                ),
            )
            Box(
                Modifier.matchParentSize().background(
                    Brush.verticalGradient(0.3f to Color.Transparent, 0.55f to Background),
                ),
            )
        }

        Column(Modifier.fillMaxSize()) {
            Row(Modifier.fillMaxWidth().padding(start = Edge, end = Edge, top = 20.dp), verticalAlignment = Alignment.CenterVertically) {
                Text("Sofarr", style = MaterialTheme.typography.titleLarge, color = Accent)
                Spacer(Modifier.weight(1f))
                OutlinedButton(onClick = onSwitchProfile) { Text("Switch profile") }
            }
            Hero(focused, Modifier.padding(horizontal = Edge).height(150.dp))
            message?.let { Text(it, modifier = Modifier.padding(Edge), style = MaterialTheme.typography.titleMedium) }
            LazyColumn(
                contentPadding = PaddingValues(bottom = 32.dp),
                verticalArrangement = Arrangement.spacedBy(14.dp),
                modifier = Modifier.fillMaxSize(),
            ) {
                itemsIndexed(rows.orEmpty(), key = { _, r -> r.id }) { rowIndex, row ->
                    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        Text(row.title, style = MaterialTheme.typography.titleSmall, modifier = Modifier.padding(start = Edge))
                        LazyRow(
                            contentPadding = PaddingValues(horizontal = Edge, vertical = 6.dp),
                            horizontalArrangement = Arrangement.spacedBy(12.dp),
                        ) {
                            itemsIndexed(row.items, key = { _, it -> it.id }) { i, item ->
                                TitleCard(
                                    item = item,
                                    imageUrl = (item.backdrop ?: item.poster)?.let(api::resolve),
                                    rank = if (row.ranked) i + 1 else null,
                                    onClick = { open(item) },
                                    modifier = Modifier
                                        .then(if (rowIndex == 0 && i == 0) Modifier.focusRequester(firstCard) else Modifier)
                                        .onFocusChanged { if (it.isFocused) focused = item },
                                )
                                if (rowIndex == 0 && i == 0 && wantFocus) {
                                    LaunchedEffect(Unit) {
                                        runCatching { firstCard.requestFocus() }
                                        wantFocus = false
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun Hero(item: RowItem?, modifier: Modifier) {
    Column(modifier.fillMaxWidth(0.5f), verticalArrangement = Arrangement.spacedBy(8.dp, Alignment.CenterVertically)) {
        if (item == null) return@Column
        Text(item.title, style = MaterialTheme.typography.headlineMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
        val meta = listOfNotNull(
            item.year?.toString(),
            if (item.mediaType == "tv") "Series" else "Movie",
            item.resume?.label,
            statusLabel(item),
        )
        Text(meta.joinToString("  ·  "), color = Muted, style = MaterialTheme.typography.bodySmall)
        Text(item.overview, maxLines = 3, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.bodySmall)
    }
}

private fun statusLabel(item: RowItem): String? = when (item.status) {
    "downloading" -> "Downloading"
    "requested" -> "Requested"
    "upcoming" -> item.availableFrom?.let { "Coming $it" } ?: "Coming soon"
    "available" -> "Not in your library"
    else -> null
}

@Composable
private fun TitleCard(item: RowItem, imageUrl: String?, rank: Int?, onClick: () -> Unit, modifier: Modifier) {
    Column(Modifier.width(184.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Card(onClick = onClick, modifier = modifier.fillMaxWidth().aspectRatio(16f / 9f)) {
            Box(Modifier.fillMaxSize().background(Color(0xFF1C1E25))) {
                if (imageUrl != null) {
                    AsyncImage(model = imageUrl, contentDescription = item.title, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize())
                } else {
                    Text(item.title, modifier = Modifier.align(Alignment.Center).padding(12.dp))
                }
                rank?.let {
                    Text(
                        "$it",
                        style = MaterialTheme.typography.titleMedium,
                        modifier = Modifier.align(Alignment.BottomStart).background(Background.copy(alpha = 0.8f)).padding(horizontal = 8.dp, vertical = 1.dp),
                    )
                }
                statusLabel(item)?.let {
                    Text(
                        it,
                        style = MaterialTheme.typography.labelSmall,
                        color = Background,
                        modifier = Modifier.align(Alignment.TopEnd).padding(4.dp).clip(RoundedCornerShape(3.dp)).background(Accent).padding(horizontal = 4.dp, vertical = 1.dp),
                    )
                }
                item.resume?.let { r ->
                    Box(Modifier.align(Alignment.BottomStart).fillMaxWidth().height(3.dp).background(Color(0x66FFFFFF))) {
                        Box(Modifier.fillMaxHeight().fillMaxWidth(r.percent.coerceIn(0, 100) / 100f).background(Accent))
                    }
                }
            }
        }
        Text(item.title, maxLines = 1, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.bodySmall)
    }
}

/** Side margin for TV overscan safety (Android TV lays out on a 960 x 540 dp screen). */
val Edge = 48.dp
