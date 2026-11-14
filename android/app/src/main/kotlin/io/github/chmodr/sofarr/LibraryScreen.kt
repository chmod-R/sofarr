package io.github.chmodr.sofarr

import android.content.Context
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.LocalBringIntoViewSpec
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.GridItemSpan
import androidx.compose.foundation.lazy.grid.LazyGridState
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
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
import androidx.compose.ui.focus.focusProperties
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.tv.material3.Text

/** Library sorts: the server sends title order; the others sort by release date. */
private enum class LibrarySort(val key: String, val label: String) {
    Title("title", "Title"),
    ReleasedAsc("released-asc", "Release Date ↑"),
    ReleasedDesc("released-desc", "Release Date ↓"),
}

private const val COLUMNS = 4

/** Remembered on this device. */
private fun loadSort(context: Context): LibrarySort {
    val v = context.getSharedPreferences("ui", Context.MODE_PRIVATE).getString("librarySort", null)
    return LibrarySort.entries.firstOrNull { it.key == v } ?: LibrarySort.Title
}

private fun saveSort(context: Context, s: LibrarySort) =
    context.getSharedPreferences("ui", Context.MODE_PRIVATE).edit().putString("librarySort", s.key).apply()

/** Sortable date: the full release date, else the year; unknown dates last either way. */
private fun sortItems(items: List<RowItem>, sort: LibrarySort): List<RowItem> {
    if (sort == LibrarySort.Title) return items
    val dir = if (sort == LibrarySort.ReleasedAsc) 1 else -1
    return items.withIndex().sortedWith { a, b ->
        val da = a.value.released ?: a.value.year?.toString()
        val db = b.value.released ?: b.value.year?.toString()
        when {
            da == db -> a.index - b.index
            da == null -> 1
            db == null -> -1
            else -> (da.compareTo(db) * dir).takeIf { it != 0 } ?: (a.index - b.index)
        }
    }.map { it.value }
}

/**
 * My Library (Home's second tab): the profile's whole Plex library as card grids,
 * TV Shows then Movies, with a sort switch above them.
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
fun LibraryScreen(
    api: SofarrApi,
    reload: Int,
    grid: LazyGridState,
    entry: FocusRequester,
    topPadding: androidx.compose.ui.unit.Dp,
    onOpen: (RowItem) -> Unit,
) {
    val context = LocalContext.current
    var sections by remember { mutableStateOf<List<Row>?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var sort by remember { mutableStateOf(loadSort(context)) }

    LaunchedEffect(reload) {
        try {
            sections = api.library().rows
            error = null
        } catch (e: Exception) {
            if (sections == null) error = "Couldn't load your library (${e.message ?: e.javaClass.simpleName})."
        }
    }

    // The header is drawn over the top of the grid: what gets focus must end up below it.
    val margin = with(LocalDensity.current) { 30.dp.toPx() }
    val header = with(LocalDensity.current) { topPadding.toPx() }
    CompositionLocalProvider(LocalBringIntoViewSpec provides remember(margin, header) { KeepVisible(margin, header) }) {
        LazyVerticalGrid(
            columns = GridCells.Fixed(COLUMNS),
            state = grid,
            modifier = Modifier.fillMaxSize(),
            contentPadding = PaddingValues(start = Tokens.Gutter, end = Tokens.Gutter, top = topPadding, bottom = 40.dp),
            horizontalArrangement = Arrangement.spacedBy(10.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            // .library-sort
            item(key = "sort", span = { GridItemSpan(maxLineSpan) }) {
                Row(Modifier.padding(top = 2.dp, bottom = 4.dp), verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text("Sort by", color = Tokens.Muted, fontWeight = FontWeight.SemiBold, fontSize = 10.sp,
                        modifier = Modifier.padding(end = 6.dp))
                    LibrarySort.entries.forEach { s ->
                        // The current sort is where focus lands coming down from the header.
                        val m = if (s == sort) Modifier.focusRequester(entry) else Modifier
                        // Right from the last one stays put (it would otherwise drop into the grid).
                        val last = if (s == LibrarySort.entries.last()) Modifier.focusProperties { right = FocusRequester.Cancel } else Modifier
                        TabButton(s.label, current = s == sort, modifier = m.then(last), onClick = {
                            sort = s
                            saveSort(context, s)
                        })
                    }
                }
            }
            error?.let { msg ->
                item(key = "error", span = { GridItemSpan(maxLineSpan) }) { Text(msg, color = Tokens.Text, fontSize = 10.sp) }
            }
            val list = sections
            if (list == null && error == null) {
                // Placeholders in the shape of what's coming.
                items(8, key = { "skel$it" }) {
                    Box(Modifier.fillMaxWidth().aspectRatio(16f / 9f).clip(RoundedCornerShape(Tokens.CardRadius)).background(Tokens.BgHover))
                }
            }
            if (list != null && list.all { it.items.isEmpty() }) {
                item(key = "empty", span = { GridItemSpan(maxLineSpan) }) {
                    Text("Nothing in your library yet. Find something on Home or with Search.", color = Tokens.Muted, fontSize = 10.sp)
                }
            }
            list.orEmpty().filter { it.items.isNotEmpty() }.forEach { section ->
                item(key = "head:${section.id}", span = { GridItemSpan(maxLineSpan) }) {
                    Text(
                        buildAnnotatedString {
                            append(section.title)
                            pushStyle(SpanStyle(color = Tokens.Muted, fontSize = 10.sp, fontWeight = FontWeight.SemiBold))
                            append("  ${section.items.size}")
                            pop()
                        },
                        color = Tokens.Text, fontSize = 13.sp, fontWeight = FontWeight.Bold,
                        modifier = Modifier.padding(top = 12.dp),
                    )
                }
                items(sortItems(section.items, sort), key = { "${section.id}:${it.id}:${sort.key}" }) { item ->
                    TitleCard(item, (item.backdrop ?: item.poster)?.let(api::resolve), onClick = { onOpen(item) }, showYear = true,
                        width = 213.dp, modifier = Modifier.fillMaxWidth())
                }
            }
        }
    }
}
