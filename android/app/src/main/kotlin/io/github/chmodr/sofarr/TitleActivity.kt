package io.github.chmodr.sofarr

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.rememberScrollState
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
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.focusProperties
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ColorMatrix
import androidx.compose.ui.graphics.ColorFilter
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import androidx.tv.material3.Text
import coil3.compose.AsyncImage
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/** A movie or show: details, Play / Get it, seasons and episodes, More Like This. */
class TitleActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val api = Sofarr.api(this) ?: return finish()
        val mediaType = intent.getStringExtra(EXTRA_TYPE) ?: return finish()
        val tmdbId = intent.getIntExtra(EXTRA_ID, 0).takeIf { it > 0 } ?: return finish()
        val preview = intent.getStringExtra(EXTRA_BACKDROP)
        val name = intent.getStringExtra(EXTRA_TITLE).orEmpty()
        setContent {
            SofarrTheme { TitleScreen(api, mediaType, tmdbId, preview, name, onBack = ::finish) }
        }
    }

    companion object {
        private const val EXTRA_TYPE = "mediaType"
        private const val EXTRA_ID = "tmdbId"
        private const val EXTRA_BACKDROP = "backdrop"
        private const val EXTRA_TITLE = "title"

        /** The card's artwork and name go along, so the page shows them while it loads. */
        fun intent(context: Context, item: RowItem): Intent = Intent(context, TitleActivity::class.java)
            .putExtra(EXTRA_TYPE, item.mediaType)
            .putExtra(EXTRA_ID, item.tmdbId)
            .putExtra(EXTRA_BACKDROP, item.backdrop)
            .putExtra(EXTRA_TITLE, item.title)
    }
}

private const val POLL_MS = 10_000L

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun TitleScreen(api: SofarrApi, mediaType: String, tmdbId: Int, preview: String?, name: String, onBack: () -> Unit) {
    val context = LocalContext.current
    var detail by remember { mutableStateOf<TitleDetail?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    var message by remember { mutableStateOf<String?>(null) }
    var reload by remember { mutableIntStateOf(0) }
    val scope = rememberCoroutineScope()
    val actions = remember { FocusRequester() }
    val open = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) { reload++ }
    // Down from the last thing above More Like This goes to its first card, not whichever card
    // happens to be nearest (the episode rows are full width, so that was the third one).
    val similarFirst = remember { FocusRequester() }
    var similarReady by remember { mutableStateOf(false) }
    val downToSimilar = Modifier.focusProperties { if (similarReady) down = similarFirst }

    suspend fun load() {
        try {
            detail = api.title(mediaType, tmdbId)
            error = null
        } catch (e: ApiException) {
            if (detail == null) error = if (e.code == 404) "We couldn't find that title." else "Couldn't load this title."
        } catch (e: Exception) {
            if (detail == null) error = "Couldn't load this title."
        }
    }

    LaunchedEffect(reload) { load() }
    // Keep progress moving while something is on its way.
    val waiting = detail?.let { d ->
        d.status == "downloading" || d.status == "requested" || d.seasons.orEmpty().any { it.status == "downloading" || it.status == "requested" }
    } == true
    LaunchedEffect(waiting) {
        while (waiting) {
            delay(POLL_MS)
            load()
        }
    }
    LaunchedEffect(detail?.id) {
        if (detail != null) {
            delay(50)
            runCatching { actions.requestFocus() }
        }
    }

    fun request(seasons: List<Int> = emptyList(), episodes: List<Int>? = null) {
        val d = detail ?: return
        busy = true
        message = null
        scope.launch {
            message = try {
                val r = api.request(d, seasons, episodes)
                r.title?.let { detail = it }
                when {
                    r.result == "already_have" -> "You already have this."
                    episodes != null -> "Requested ${if (episodes.size == 1) "episode ${episodes[0]}" else "${episodes.size} episodes"}. " +
                        "Searching now. Each one shows up as soon as it's downloaded."
                    d.status == "upcoming" -> "Requested. It'll download when it's released."
                    else -> "Requested. Searching now…"
                }
            } catch (e: ApiException) {
                when (e.error) {
                    "season_numbering_mismatch" -> {
                        load() // the server now knows Sonarr's numbering
                        "Season numbers were updated. Please check your choice and try again."
                    }
                    "restricted_profile" -> "This profile can't request titles."
                    else -> e.detail?.let { "Couldn't request: $it" } ?: "Couldn't request it. Try again."
                }
            } catch (e: Exception) {
                "Couldn't request it. Try again."
            } finally {
                busy = false
            }
        }
    }

    fun play(plexKey: String) = open.launch(Intent(context, PlayerActivity::class.java).putExtra(PlayerActivity.EXTRA_PLEX_KEY, plexKey))

    val d = detail
    Box(Modifier.fillMaxSize().background(Tokens.Bg)) {
        // The card-sized image first (already loaded on Home), then the large one over it.
        val small = (d?.backdrop ?: preview)?.let(api::resolve)
        if (small != null) AsyncImage(model = small, contentDescription = null, contentScale = ContentScale.Crop,
            alignment = Alignment.TopCenter, modifier = Modifier.fillMaxSize())
        largeBackdrop(d?.backdrop ?: preview)?.let(api::resolve)?.takeIf { it != small }?.let {
            AsyncImage(model = it, contentDescription = null, contentScale = ContentScale.Crop, alignment = Alignment.TopCenter, modifier = Modifier.fillMaxSize())
        }
        Box(Modifier.fillMaxSize().background(Brush.horizontalGradient(0f to Tokens.Bg.copy(alpha = 0.97f), 0.45f to Tokens.Bg.copy(alpha = 0.75f), 0.8f to Tokens.Bg.copy(alpha = 0.15f))))
        Box(Modifier.fillMaxSize().background(Brush.verticalGradient(0.5f to Color.Transparent, 1f to Tokens.Bg.copy(alpha = 0.9f))))

        if (error != null) {
            Centered {
                Text(error!!, color = Tokens.Text, fontSize = 11.sp)
                SofarrButton("Back", onBack, modifier = Modifier.focusRequester(actions))
            }
            LaunchedEffect(Unit) { runCatching { actions.requestFocus() } }
        } else {
            // Unlike Home, the page only scrolls as far as it must to show what's focused.
            val margin = with(LocalDensity.current) { 40.dp.toPx() }
            CompositionLocalProvider(LocalBringIntoViewSpec provides remember(margin) { KeepVisible(margin) }) {
                // A plain scrolling page (not lazy): everything stays built, so focus can move to any
                // part of it, e.g. Down from the last episode straight to More Like This.
                Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(bottom = 50.dp)) {
                    TitleBody(api, d, name, busy, actions, downToSimilar, onPlay = ::play, onRequest = { request() }, onTrailer = { key ->
                        runCatching {
                            context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("https://www.youtube.com/watch?v=$key")))
                        }.onFailure { message = "No app here can play the trailer." }
                    }, onBack = onBack)
                    if (d != null && d.mediaType == "tv" && !d.seasons.isNullOrEmpty()) {
                        Seasons(api, d, busy, reload, downToSimilar, onRequest = { s, e -> request(s, e) }, onPlay = ::play)
                    }
                    if (d != null) {
                        MoreLikeThis(api, d.mediaType, d.tmdbId, similarFirst, onReady = { similarReady = it },
                            onOpen = { openItem(context, it, open::launch) })
                    }
                }
            }
        }
        Toast(message) { message = null }
    }
}

@Composable
private fun TitleBody(
    api: SofarrApi,
    d: TitleDetail?,
    name: String,
    busy: Boolean,
    actions: FocusRequester,
    downToSimilar: Modifier,
    onPlay: (String) -> Unit,
    onRequest: () -> Unit,
    onTrailer: (String) -> Unit,
    onBack: () -> Unit,
) {
    Column(Modifier.padding(start = Tokens.Gutter, end = Tokens.Gutter, top = 97.dp).widthIn(max = 520.dp)) {
        // Logo, else the name.
        val logo = d?.logo?.let(api::resolve)
        if (logo != null) {
            AsyncImage(model = logo, contentDescription = d.title, contentScale = ContentScale.Fit, alignment = Alignment.BottomStart,
                modifier = Modifier.widthIn(max = 300.dp).heightIn(max = 119.dp))
        } else {
            Text(d?.title ?: name, fontSize = 38.sp, fontWeight = FontWeight.ExtraBold, lineHeight = 1.05.em, color = Tokens.Text)
        }
        if (d == null) {
            // Placeholders in the shape of what's coming (the web's skeleton).
            Spacer(Modifier.height(12.dp))
            Box(Modifier.width(160.dp).height(13.dp).clip(RoundedCornerShape(Tokens.Radius)).background(Tokens.BgHover))
            Spacer(Modifier.height(12.dp))
            repeat(3) {
                Box(Modifier.fillMaxWidth(if (it == 2) 0.6f else 1f).height(9.dp).clip(RoundedCornerShape(Tokens.Radius)).background(Tokens.BgHover))
                Spacer(Modifier.height(6.dp))
            }
            return@Column
        }
        d.tagline?.takeIf { it.isNotBlank() }?.let {
            Spacer(Modifier.height(5.dp))
            Text(it, color = Tokens.Muted, fontStyle = FontStyle.Italic, fontSize = 10.sp)
        }
        Spacer(Modifier.height(9.dp))
        val isTv = d.mediaType == "tv"
        val seasonCount = d.seasons?.size ?: 0
        MetaRow {
            d.year?.let { MetaText("$it") }
            d.certification?.let { Cert(it) }
            (if (isTv && seasonCount > 0) "$seasonCount ${if (seasonCount == 1) "Season" else "Seasons"}" else runtime(d.runtime))?.let { MetaText(it) }
            d.genres.take(3).takeIf { it.isNotEmpty() }?.let { MetaText(it.joinToString(", ")) }
            d.rating?.let { MetaText("★ ${"%.1f".format(it)}") }
            StatusPill(d.status, statusLabel(d.status, d.availableFrom, d.download))
        }
        Spacer(Modifier.height(9.dp))
        if (d.status == "downloading" && d.download != null) {
            ProgressBar(d.download.percent.toFloat(), Tokens.Info, Modifier.width(240.dp).height(4.dp).clip(RoundedCornerShape(50)),
                track = Color.White.copy(alpha = 0.2f))
            Spacer(Modifier.height(10.dp))
        }
        Text(d.overview, color = Tokens.Overview, fontSize = 11.sp, lineHeight = 1.4.em, modifier = Modifier.widthIn(max = 440.dp))
        if (d.cast.isNotEmpty()) {
            Spacer(Modifier.height(8.dp))
            Text(
                androidx.compose.ui.text.buildAnnotatedString {
                    pushStyle(androidx.compose.ui.text.SpanStyle(color = Tokens.Muted)); append("Starring "); pop()
                    append(d.cast.joinToString(", "))
                },
                color = Tokens.Text, fontSize = 9.5.sp, modifier = Modifier.widthIn(max = 440.dp),
            )
        }
        Spacer(Modifier.height(15.dp))
        // The main action, by status (the web's `primary`).
        val primary: Pair<String, () -> Unit>? = when (d.status) {
            "owned" -> d.plexKey?.let { key -> "▶ Play" to { onPlay(key) } }
            "available" -> if (isTv) null else (if (busy) "Requesting…" else "Get it") to onRequest
            "upcoming" -> if (isTv) null else (if (busy) "Requesting…" else d.availableFrom?.let { "Get it on ${shortDate(it)}" } ?: "Get it when it's out") to onRequest
            "requested" -> if (isTv) null else (if (busy) "Searching…" else "Search again") to onRequest
            else -> null
        }
        // Movies have no episodes: Down from these buttons goes to More Like This.
        val down = if (isTv) Modifier else downToSimilar
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp), modifier = Modifier.padding(vertical = 4.dp)) {
            var first = true
            fun Modifier.firstFocus(): Modifier = then(down).let { if (first) { first = false; it.focusRequester(actions) } else it }
            primary?.let { (label, action) ->
                SofarrButton(label, action, kind = ButtonKind.Primary, enabled = !busy || d.status == "owned", modifier = Modifier.firstFocus())
            }
            d.trailerYoutubeKey?.let { key -> SofarrButton("Trailer", { onTrailer(key) }, modifier = Modifier.firstFocus()) }
            SofarrButton("Back", onBack, kind = ButtonKind.Quiet, modifier = Modifier.firstFocus())
        }
        Spacer(Modifier.height(30.dp))
    }
}

/** Seasons that make sense to ask for. */
private fun requestable(s: SeasonInfo) = s.status == "available" || s.status == "partial" || s.status == "upcoming"

/** One line about a season: what you have, what you've watched, what's on its way. */
private fun seasonSummary(s: SeasonInfo): String = listOfNotNull(
    if (s.episodeCount > 0) "${if (s.inPlex > 0) "${s.inPlex} of " else ""}${s.episodeCount} episodes${if (s.inPlex > 0) " in your library" else ""}" else null,
    if (s.inPlex > 0) (if (s.watched >= s.inPlex) "All watched" else if (s.watched > 0) "${s.watched} watched" else null) else null,
    if (s.inPlex == 0) s.airDate?.let(::shortDate) else null,
    when (s.status) { "downloading" -> "Downloading"; "requested" -> "Requested"; "upcoming" -> "Not aired yet"; else -> null },
).joinToString(" · ")

/** The season to open first: the one you're in the middle of, else the first you have, else the first to get. */
private fun startSeason(seasons: List<SeasonInfo>): Int? = (
    seasons.firstOrNull { it.inPlex > 0 && it.watched < it.inPlex }
        ?: seasons.firstOrNull { it.inPlex > 0 }
        ?: seasons.firstOrNull(::requestable)
        ?: seasons.firstOrNull()
    )?.number

@Composable
private fun SectionTitle(text: String) =
    Text(text, color = Tokens.Text, fontSize = 15.sp, fontWeight = FontWeight.Bold, modifier = Modifier.padding(bottom = 9.dp))

@Composable
private fun Seasons(
    api: SofarrApi,
    d: TitleDetail,
    busy: Boolean,
    refresh: Int,
    downToSimilar: Modifier,
    onRequest: (List<Int>, List<Int>?) -> Unit,
    onPlay: (String) -> Unit,
) {
    val seasons = d.seasons.orEmpty()
    var current by remember(d.id) { mutableStateOf(startSeason(seasons)) }
    val season = seasons.firstOrNull { it.number == current } ?: seasons.first()
    val wanted = seasons.filter(::requestable)
    Column(Modifier.background(Brush.verticalGradient(0f to Color.Transparent, 0.05f to Tokens.Bg)).padding(horizontal = Tokens.Gutter).padding(top = 10.dp)) {
        SectionTitle("Episodes")
        if (seasons.size > 1) {
            LazyRow(horizontalArrangement = Arrangement.spacedBy(4.dp), contentPadding = PaddingValues(vertical = 5.dp, horizontal = 2.dp)) {
                items(seasons, key = { it.number }) { s ->
                    TabButton(s.name, current = s.number == season.number, onClick = { current = s.number })
                }
            }
            Spacer(Modifier.height(4.dp))
        }
        Row(Modifier.fillMaxWidth().heightIn(min = 28.dp).padding(bottom = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(
                androidx.compose.ui.text.buildAnnotatedString {
                    if (seasons.size == 1) {
                        pushStyle(androidx.compose.ui.text.SpanStyle(color = Tokens.Text, fontWeight = FontWeight.Bold)); append(season.name + "   "); pop()
                    }
                    append(seasonSummary(season))
                    season.tmdbNumber?.let { append("  (TMDb season $it)") }
                },
                color = Tokens.Muted, fontSize = 10.sp, modifier = Modifier.weight(1f),
            )
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                if (requestable(season)) {
                    SofarrButton(if (season.status == "partial") "Get the rest of ${season.name}" else "Get ${season.name}",
                        { onRequest(listOf(season.number), null) }, enabled = !busy, small = true)
                }
                if (wanted.size > 1) {
                    SofarrButton(if (wanted.size == seasons.size) "Get all ${wanted.size} seasons" else "Get all ${wanted.size} missing seasons",
                        { onRequest(wanted.map { it.number }, null) }, kind = ButtonKind.Quiet, enabled = !busy, small = true)
                }
            }
        }
        EpisodeList(api, d, season, busy, refresh, downToSimilar, onRequest, onPlay)
        Spacer(Modifier.height(30.dp))
    }
}

@Composable
private fun EpisodeList(
    api: SofarrApi,
    d: TitleDetail,
    season: SeasonInfo,
    busy: Boolean,
    refresh: Int,
    downToSimilar: Modifier,
    onRequest: (List<Int>, List<Int>?) -> Unit,
    onPlay: (String) -> Unit,
) {
    var data by remember(season.number) { mutableStateOf<SeasonEpisodes?>(null) }
    var failed by remember(season.number) { mutableStateOf(false) }
    var asked by remember { mutableStateOf<Int?>(null) }
    LaunchedEffect(d, season.number, refresh) {
        runCatching { api.episodes(d.tmdbId, season.number, d.numbering) }
            .onSuccess { data = it; failed = false }
            .onFailure { if (data == null) failed = true }
    }
    LaunchedEffect(busy) { if (!busy) asked = null }
    val eps = data
    when {
        failed && eps == null -> Text("Couldn't load episodes.", color = Tokens.Muted, fontSize = 10.sp, modifier = Modifier.padding(vertical = 10.dp))
        eps == null -> repeat(minOf(season.episodeCount.takeIf { it > 0 } ?: 4, 6)) {
            Row(Modifier.padding(7.dp), horizontalArrangement = Arrangement.spacedBy(13.dp)) {
                Box(Modifier.width(130.dp).aspectRatio(16f / 9f).clip(RoundedCornerShape(3.5.dp)).background(Tokens.BgHover))
                Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Box(Modifier.width(180.dp).height(10.dp).clip(RoundedCornerShape(Tokens.Radius)).background(Tokens.BgHover))
                    Box(Modifier.width(300.dp).height(8.dp).clip(RoundedCornerShape(Tokens.Radius)).background(Tokens.BgHover))
                }
            }
        }
        eps.episodes.isEmpty() -> Text("No episodes listed yet.", color = Tokens.Muted, fontSize = 10.sp, modifier = Modifier.padding(vertical = 10.dp))
        else -> Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
            eps.episodes.forEachIndexed { i, e ->
                val last = i == eps.episodes.lastIndex
                EpisodeRow(api, e, busy, requesting = busy && asked == e.number, modifier = if (last) downToSimilar else Modifier, onSelect = {
                    val key = e.plexKey
                    if (key != null) onPlay(key)
                    else if (e.status == "available" || e.status == "upcoming") {
                        asked = e.number
                        onRequest(listOf(season.number), listOf(e.number))
                    }
                })
            }
        }
    }
}

private fun minutesLeft(ms: Long): String {
    val m = maxOf(1, Math.round(ms / 60_000.0).toInt())
    return if (m >= 60) "${m / 60}h ${m % 60}m" else "$m min"
}

@Composable
private fun EpisodeRow(api: SofarrApi, e: EpisodeInfo, busy: Boolean, requesting: Boolean, modifier: Modifier, onSelect: () -> Unit) {
    // What Enter does, as shown at the row's right edge.
    val (label, kind) = when {
        e.plexKey != null -> (if (e.progress != null) "▶ Resume" else "▶ Play") to "play"
        requesting -> "Requesting…" to "wait"
        e.status == "available" -> "Get it" to "get"
        e.status == "upcoming" -> "Get when aired" to "get"
        e.status == "downloading" -> "Downloading" to "wait"
        e.status == "requested" -> "Requested" to "wait"
        else -> "" to "none"
    }
    val facts = listOfNotNull(
        e.progress?.let { "${minutesLeft(it.remainingMs)} left" } ?: runtime(e.runtime),
        e.airDate?.let(::shortDate),
        if (e.watched && e.progress == null) "Watched" else null,
    ).joinToString(" · ")
    FocusBox(onClick = { if (!(kind == "get" && busy)) onSelect() }, modifier = modifier.fillMaxWidth(), focusedScale = 1f) { focused ->
        Row(
            Modifier.fillMaxWidth().background(if (focused) Tokens.BgHover else Color.Transparent).padding(7.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(13.dp),
        ) {
            Box(Modifier.width(130.dp).aspectRatio(16f / 9f).clip(RoundedCornerShape(3.5.dp)).background(Tokens.BgRaised)) {
                // Episodes you don't have yet are dimmed until they're playable.
                // (grayscale 0.6, brightness 0.6 on the web)
                val dim = if (kind != "play") {
                    ColorFilter.colorMatrix(ColorMatrix().apply {
                        setToSaturation(0.4f)
                        timesAssign(ColorMatrix().apply { setToScale(0.6f, 0.6f, 0.6f, 1f) })
                    })
                } else null
                e.still?.let { AsyncImage(model = api.resolve(it), contentDescription = null, contentScale = ContentScale.Crop,
                    colorFilter = dim, modifier = Modifier.fillMaxSize()) }
                    ?: Box(Modifier.fillMaxSize().background(Brush.linearGradient(listOf(Color(0xFF2A2D38), Tokens.BgRaised))))
                if (e.plexKey != null && focused) {
                    Box(Modifier.fillMaxSize().background(Color.Black.copy(alpha = 0.35f)), contentAlignment = Alignment.Center) {
                        Text("▶", color = Tokens.Text, fontSize = 16.sp)
                    }
                }
                if (e.watched && e.progress == null) {
                    Box(Modifier.align(Alignment.TopEnd).padding(3.5.dp).size(14.dp).clip(RoundedCornerShape(50)).background(Tokens.Ok),
                        contentAlignment = Alignment.Center) {
                        Text("✓", color = Color(0xFF06210F), fontSize = 8.sp, fontWeight = FontWeight.ExtraBold)
                    }
                }
                e.progress?.let {
                    ProgressBar(maxOf(3, it.percent).toFloat(), Tokens.Accent, Modifier.align(Alignment.BottomStart).fillMaxWidth().height(2.5.dp),
                        track = Color.White.copy(alpha = 0.3f))
                }
            }
            Column(Modifier.weight(1f)) {
                Row(verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    Text("${e.number}. ${e.title}", color = if (e.watched) Tokens.Muted else Tokens.Text, fontSize = 10.5.sp,
                        fontWeight = FontWeight.Bold, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
                    Text(facts, color = Tokens.Muted, fontSize = 8.5.sp, maxLines = 1)
                }
                if (e.overview.isNotBlank()) {
                    Spacer(Modifier.height(3.dp))
                    Text(e.overview, color = Color(0xFFC3C5CD), fontSize = 9.2.sp, lineHeight = 1.4.em, maxLines = 2, overflow = TextOverflow.Ellipsis)
                }
            }
            if (label.isNotEmpty()) {
                val (bg, fg) = when {
                    kind == "get" && focused -> Tokens.Accent to Tokens.AccentInk
                    kind == "get" -> Tokens.Accent.copy(alpha = 0.2f) to Tokens.Accent
                    kind == "play" && focused -> Tokens.Text to Tokens.Bg
                    kind == "play" -> Color.Transparent to Tokens.Text
                    else -> Color.Transparent to Tokens.Muted
                }
                Text(label, color = fg, fontSize = 8.5.sp, fontWeight = FontWeight.Bold, maxLines = 1,
                    modifier = Modifier.clip(RoundedCornerShape(50)).background(bg).padding(horizontal = 9.dp, vertical = 3.5.dp))
            }
        }
    }
}

@Composable
private fun MoreLikeThis(
    api: SofarrApi,
    mediaType: String,
    tmdbId: Int,
    firstCard: FocusRequester,
    onReady: (Boolean) -> Unit,
    onOpen: (RowItem) -> Unit,
) {
    var items by remember { mutableStateOf<List<RowItem>?>(null) }
    LaunchedEffect(mediaType, tmdbId) {
        items = runCatching { api.similar(mediaType, tmdbId) }.getOrDefault(emptyList()) // optional: the page is complete without it
    }
    // Only point Down at the first card once it exists.
    LaunchedEffect(items) { onReady(!items.isNullOrEmpty()) }
    val list = items
    if (list != null && list.isEmpty()) return
    Column(Modifier.background(Tokens.Bg).padding(horizontal = Tokens.Gutter).padding(top = 10.dp)) {
        SectionTitle("More Like This")
        // A grid, four across (auto-fill of card-width columns on the web).
        val columns = 4
        val chunks = list?.chunked(columns) ?: List(2) { emptyList() }
        Column {
        chunks.forEachIndexed { r, chunk ->
            Row(Modifier.padding(vertical = 5.5.dp), horizontalArrangement = Arrangement.spacedBy(9.dp)) {
                if (list == null) {
                    repeat(columns) { Box(Modifier.weight(1f).aspectRatio(16f / 9f).clip(RoundedCornerShape(Tokens.CardRadius)).background(Tokens.BgHover)) }
                } else {
                    chunk.forEachIndexed { c, t ->
                        Box(Modifier.weight(1f)) {
                            TitleCard(t, (t.backdrop ?: t.poster)?.let(api::resolve), onClick = { onOpen(t) }, showYear = true,
                                width = 214.dp,
                                modifier = Modifier.fillMaxWidth().then(if (r == 0 && c == 0) Modifier.focusRequester(firstCard) else Modifier))
                        }
                    }
                    repeat(columns - chunk.size) { Spacer(Modifier.weight(1f)) }
                }
            }
        }
        }
    }
}
