package io.github.chmodr.sofarr

import android.content.Context
import android.content.Intent
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.gestures.LocalBringIntoViewSpec
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
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
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.grid.rememberLazyGridState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Shadow
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import androidx.tv.material3.Text
import coil3.compose.AsyncImage
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/** Home: the hero's share of the screen (56% of its height); the rows get the rest. */
private val HeroHeight = 302.dp

/** From the top of a row to its cards: the title (13 sp) and the track's top padding. */
private val RowHead = 34.dp

/** Title logos, looked up once per title for the life of the app. */
object Logos {
    private val known = mutableStateMapOf<String, String?>()
    private val loading = mutableSetOf<String>()

    fun get(key: String): String? = known[key]
    fun has(key: String) = known.containsKey(key)

    suspend fun load(api: SofarrApi, mediaType: String, tmdbId: Int) {
        val key = "$mediaType:$tmdbId"
        if (known.containsKey(key) || !loading.add(key)) return
        known[key] = runCatching { api.logo(mediaType, tmdbId)?.let(api::resolve) }.getOrNull()
        loading.remove(key)
    }
}

/** Open what a card points at: resume straight into the player, else the title page. */
fun openItem(context: Context, item: RowItem, launch: (Intent) -> Unit) {
    val resume = item.resume
    launch(
        if (resume != null) {
            Intent(context, PlayerActivity::class.java).putExtra(PlayerActivity.EXTRA_PLEX_KEY, resume.plexKey)
        } else {
            TitleActivity.intent(context, item)
        },
    )
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
fun HomeScreen(api: SofarrApi, onSwitchProfile: () -> Unit, onSignOut: () -> Unit, onSessionLost: () -> Unit) {
    val context = LocalContext.current
    val density = LocalDensity.current
    var rows by remember { mutableStateOf<List<Row>?>(null) }
    var warnings by remember { mutableStateOf<List<String>>(emptyList()) }
    var error by remember { mutableStateOf<String?>(null) }
    var selected by remember { mutableStateOf<Pair<String, RowItem>?>(null) }
    var shown by remember { mutableStateOf<RowItem?>(null) }
    var profile by remember { mutableStateOf<Profile?>(null) }
    var menuOpen by remember { mutableStateOf(false) }
    var tab by remember { mutableStateOf("home") }
    val libraryGrid = rememberLazyGridState()
    val libraryEntry = remember { FocusRequester() }
    var reload by remember { mutableIntStateOf(0) }
    var wantFocus by remember { mutableStateOf(false) }
    val firstCard = remember { FocusRequester() }
    val scope = rememberCoroutineScope()
    val open = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) { reload++ }

    LaunchedEffect(Unit) { profile = runCatching { api.session().profile }.getOrNull() }

    // Refresh every 60 s, every 15 s while something downloads, and when coming back.
    LaunchedEffect(reload) {
        while (true) {
            try {
                val firstLoad = rows == null
                val home = api.home()
                rows = home.rows.filter { it.items.isNotEmpty() }
                warnings = home.warnings
                error = null
                if (firstLoad) wantFocus = true
            } catch (e: ApiException) {
                // Signed out elsewhere (or the session ran out), or no profile selected: back to sign-in / profiles.
                if (e.code == 401 || e.error == "no_profile_selected") return@LaunchedEffect onSessionLost()
                if (rows == null) error = "Couldn't load Home (${e.message})."
            } catch (e: Exception) {
                if (rows == null) error = "Couldn't load Home (${e.message ?: e.javaClass.simpleName})."
            }
            val downloading = rows.orEmpty().any { r -> r.items.any { it.status == "downloading" } }
            delay(if (downloading) 15_000 else 60_000)
        }
    }

    // The hero follows the selection once it rests (180 ms), so holding an arrow doesn't load every title.
    val target = selected?.second ?: rows?.firstOrNull()?.items?.firstOrNull()
    LaunchedEffect(target?.id) {
        if (shown != null && target != null && shown?.id != target.id) delay(180)
        shown = target
    }
    // Same title, newer data (a refresh): show it straight away.
    val hero = shown?.let { s -> rows?.firstNotNullOfOrNull { r -> r.items.firstOrNull { it.id == s.id } } ?: s }

    BackHandler(enabled = menuOpen) { menuOpen = false }
    // Back from My Library goes to Home.
    BackHandler(enabled = !menuOpen && tab == "library") { tab = "home" }

    Box(Modifier.fillMaxSize().background(Tokens.Bg)) {
        if (tab == "library") {
            LibraryScreen(api, reload, libraryGrid, libraryEntry, topPadding = 58.dp, onOpen = { openItem(context, it, open::launch) })
        } else {
            if (hero != null) Hero(api, hero)

            // Rows scroll in their own area under the hero: the selected row moves to the top. The focused
            // card is what asks to be shown, so leave room above it for its row's title.
            val rowHead = with(density) { RowHead.toPx() }
            CompositionLocalProvider(LocalBringIntoViewSpec provides remember(rowHead) { PinToStart(rowHead) }) {
                LazyColumn(
                    modifier = Modifier.fillMaxSize().padding(top = HeroHeight),
                    contentPadding = PaddingValues(top = 4.dp, bottom = 380.dp),
                ) {
                    error?.let { msg ->
                        item {
                            Column(Modifier.padding(horizontal = Tokens.Gutter, vertical = 10.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                                Text(msg, color = Tokens.Text, fontSize = 10.sp)
                                SofarrButton("Try again", { reload++ }, kind = ButtonKind.Primary)
                            }
                        }
                    }
                    itemsIndexed(rows.orEmpty(), key = { _, r -> r.id }) { rowIndex, row ->
                        val active = selected?.first == row.id || (selected == null && rowIndex == 0)
                        HomeRow(
                            api = api,
                            row = row,
                            active = active,
                            firstCard = if (rowIndex == 0) firstCard else null,
                            onFocused = { selected = row.id to it },
                            onOpen = { openItem(context, it, open::launch) },
                        )
                    }
                    if (warnings.isNotEmpty()) {
                        item {
                            Text("Some rows are missing: ${warnings.joinToString("; ")}", color = Tokens.Muted, fontSize = 8.5.sp,
                                modifier = Modifier.padding(horizontal = Tokens.Gutter, vertical = 10.dp))
                        }
                    }
                }
            }

        }

        // Over the artwork the header has a shade; on My Library it turns solid once the grid scrolls under it.
        val solid = tab == "library" && (libraryGrid.firstVisibleItemIndex > 0 || libraryGrid.firstVisibleItemScrollOffset > 0)
        // Down from the header goes into the page (Compose's own search doesn't get there from the overlay).
        Header(api, profile, menuOpen, tab, solid, down = if (tab == "library") libraryEntry else firstCard, onTab = { tab = it }, onToggleMenu = { menuOpen = !menuOpen }, onSwitchProfile = {
            menuOpen = false
            onSwitchProfile()
        }, onSignOut = {
            menuOpen = false
            onSignOut()
        })
    }

    if (wantFocus) {
        LaunchedEffect(Unit) {
            delay(50)
            runCatching { firstCard.requestFocus() }
            wantFocus = false
        }
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun HomeRow(
    api: SofarrApi,
    row: Row,
    active: Boolean,
    firstCard: FocusRequester?,
    onFocused: (RowItem) -> Unit,
    onOpen: (RowItem) -> Unit,
) {
    val titleColor by animateColorAsState(if (active) Tokens.Text else Tokens.Muted, tween(200), label = "row-title")
    val gutterPx = with(LocalDensity.current) { Tokens.Gutter.toPx() }
    Column(Modifier.padding(bottom = 10.dp)) {
        Text(row.title, color = titleColor, fontSize = 13.sp, fontWeight = FontWeight.Bold,
            modifier = Modifier.padding(start = Tokens.Gutter, bottom = 2.dp))
        // The selected card stays at the row's left edge.
        CompositionLocalProvider(LocalBringIntoViewSpec provides remember(gutterPx) { PinToStart(gutterPx) }) {
            LazyRow(
                contentPadding = PaddingValues(start = Tokens.Gutter, top = 10.dp, bottom = 11.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                itemsIndexed(row.items, key = { _, it -> it.id }) { i, item ->
                    TitleCard(
                        item = item,
                        imageUrl = (item.backdrop ?: item.poster)?.let(api::resolve),
                        rank = if (row.ranked) i + 1 else null,
                        focusedScale = 1.05f,
                        onClick = { onOpen(item) },
                        onFocus = { onFocused(item) },
                        modifier = if (i == 0 && firstCard != null) Modifier.focusRequester(firstCard) else Modifier,
                    )
                }
                // Room to bring the last cards to the left edge too.
                item { Spacer(Modifier.width(960.dp - Tokens.CardWidth - Tokens.Gutter * 2)) }
            }
        }
    }
}

/** The top of Home: artwork, logo and details of the selected card. Nothing in it takes focus. */
@Composable
private fun Hero(api: SofarrApi, item: RowItem) {
    LaunchedEffect(item.mediaType, item.tmdbId) { Logos.load(api, item.mediaType, item.tmdbId) }
    Box(Modifier.fillMaxWidth().height(HeroHeight)) {
        // .hero-art: right-aligned 16:9 artwork, blended into the page on the sides it doesn't reach.
        Box(Modifier.align(Alignment.TopEnd).fillMaxHeight().width(HeroHeight * 16 / 9)) {
            AnimatedContent(largeBackdrop(item.backdrop)?.let(api::resolve), transitionSpec = {
                fadeIn(tween(500)) togetherWith fadeOut(tween(500))
            }, label = "hero-art") { url ->
                if (url != null) {
                    AsyncImage(model = url, contentDescription = null, contentScale = ContentScale.Crop,
                        alignment = Alignment.TopCenter, modifier = Modifier.fillMaxSize())
                }
            }
            Box(Modifier.fillMaxSize().background(Brush.horizontalGradient(0f to Tokens.Bg, 0.22f to Tokens.Bg.copy(alpha = 0.6f), 0.55f to Color.Transparent)))
            Box(Modifier.fillMaxSize().background(Brush.verticalGradient(0.55f to Color.Transparent, 0.82f to Tokens.Bg.copy(alpha = 0.5f), 1f to Tokens.Bg)))
        }
        AnimatedContent(item.id, transitionSpec = { fadeIn(tween(350)) togetherWith fadeOut(tween(200)) },
            modifier = Modifier.align(Alignment.BottomStart).padding(start = Tokens.Gutter, bottom = 11.dp), label = "hero-body") { _ ->
            HeroBody(item)
        }
    }
}

@Composable
private fun HeroBody(item: RowItem) {
    val key = "${item.mediaType}:${item.tmdbId}"
    Column(Modifier.widthIn(max = 400.dp)) {
        // A fixed slot: the lines below stay put whatever the logo's shape.
        Box(Modifier.height(81.dp).fillMaxWidth(), contentAlignment = Alignment.BottomStart) {
            val logo = Logos.get(key)
            if (Logos.has(key)) {
                if (logo != null) {
                    AsyncImage(model = logo, contentDescription = item.title, contentScale = ContentScale.Fit,
                        alignment = Alignment.BottomStart, modifier = Modifier.widthIn(max = 260.dp).fillMaxHeight())
                } else {
                    Text(item.title, fontSize = 30.sp, fontWeight = FontWeight.ExtraBold, lineHeight = 1.05.em, maxLines = 2,
                        overflow = TextOverflow.Ellipsis, color = Tokens.Text,
                        style = TextStyle(shadow = Shadow(Color.Black.copy(alpha = 0.7f), blurRadius = 16f)))
                }
            }
        }
        Spacer(Modifier.height(9.dp))
        MetaRow {
            item.year?.let { MetaText("$it") }
            MetaText(if (item.mediaType == "tv") "Series" else "Movie")
            item.rating?.let { MetaText("★ ${"%.1f".format(it)}") }
            StatusPill(item.status, item.resume?.label?.let { "Continue · $it" } ?: statusLabel(item.status, item.availableFrom, item.download))
        }
        Spacer(Modifier.height(9.dp))
        Text(item.overview, color = Tokens.Overview, fontSize = 10.5.sp, lineHeight = 1.45.em, maxLines = 3,
            overflow = TextOverflow.Ellipsis, modifier = Modifier.heightIn(min = 46.dp),
            style = TextStyle(shadow = Shadow(Color.Black.copy(alpha = 0.6f), blurRadius = 6f)))
    }
}

/** Brand on the left, the profile (with its menu) on the right, over a shade. */
@Composable
private fun Header(
    api: SofarrApi,
    profile: Profile?,
    menuOpen: Boolean,
    tab: String,
    solid: Boolean,
    down: FocusRequester,
    onTab: (String) -> Unit,
    onToggleMenu: () -> Unit,
    onSwitchProfile: () -> Unit,
    onSignOut: () -> Unit,
) {
    val shade by animateColorAsState(if (solid) Tokens.Bg else Color.Transparent, tween(250), label = "header")
    Box(Modifier.fillMaxWidth()) {
        Row(
            Modifier.fillMaxWidth()
                .onPreviewKeyEvent { e ->
                    e.type == KeyEventType.KeyDown && e.key == Key.DirectionDown && runCatching { down.requestFocus() }.getOrDefault(false)
                }
                .background(shade)
                .background(Brush.verticalGradient(listOf(Color(0xCC08090C), Color.Transparent)))
                .padding(horizontal = Tokens.Gutter, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text("Sofarr", color = Tokens.Accent, fontSize = 16.sp, fontWeight = FontWeight.ExtraBold, letterSpacing = 0.02.em)
            // Switching tabs keeps focus on the tab.
            Row(Modifier.padding(start = 25.dp), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                TabButton("Home", current = tab == "home", onClick = { onTab("home") })
                TabButton("My Library", current = tab == "library", onClick = { onTab("library") })
            }
            Spacer(Modifier.weight(1f))
            val context = LocalContext.current
            FocusBox({ context.startActivity(Intent(context, SearchActivity::class.java)) }, shape = RoundedCornerShape(50), radius = 50.dp) { focused ->
                Box(Modifier.background(if (focused) Tokens.Text else Color.Transparent).padding(5.5.dp)) {
                    SearchIcon(if (focused) Tokens.Bg else Tokens.Text)
                }
            }
            Spacer(Modifier.width(6.dp))
            FocusBox(onToggleMenu, shape = RoundedCornerShape(6.dp), radius = 6.dp) { focused ->
                Box(Modifier.background(if (menuOpen && !focused) Color.White.copy(alpha = 0.14f) else Color.Transparent).padding(3.dp)) {
                    Avatar(api, profile, 21.dp)
                }
            }
        }
        if (menuOpen) ProfileMenu(api, profile, onSwitchProfile, onSignOut, Modifier.align(Alignment.TopEnd).padding(top = 48.dp, end = Tokens.Gutter))
    }
}

@Composable
fun Avatar(api: SofarrApi, profile: Profile?, size: androidx.compose.ui.unit.Dp) {
    val shape = RoundedCornerShape(if (size < 40.dp) 3.5.dp else 6.dp)
    Box(Modifier.size(size).clip(shape).background(Brush.linearGradient(listOf(Color(0xFF3A3F52), Tokens.BgHover))),
        contentAlignment = Alignment.Center) {
        val thumb = profile?.thumb
        if (thumb != null) {
            AsyncImage(model = api.resolve(thumb), contentDescription = profile.title, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize())
        } else {
            Text(profile?.title?.take(1)?.uppercase() ?: "", color = Tokens.Text, fontWeight = FontWeight.Bold, fontSize = (size.value * 0.45f).sp)
        }
    }
}

@Composable
private fun ProfileMenu(api: SofarrApi, profile: Profile?, onSwitchProfile: () -> Unit, onSignOut: () -> Unit, modifier: Modifier) {
    val first = remember { FocusRequester() }
    LaunchedEffect(Unit) { runCatching { first.requestFocus() } }
    Column(
        modifier.width(140.dp)
            .clip(RoundedCornerShape(Tokens.Radius))
            .background(Color(0xF7191B22))
            .border(1.dp, Color.White.copy(alpha = 0.1f), RoundedCornerShape(Tokens.Radius))
            .padding(5.dp),
    ) {
        Row(Modifier.padding(start = 9.dp, end = 9.dp, top = 5.dp, bottom = 8.dp), verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(7.dp)) {
            Avatar(api, profile, 18.dp)
            Text(profile?.title ?: "", color = Tokens.Text, fontWeight = FontWeight.Bold, fontSize = 10.sp, maxLines = 1)
        }
        Box(Modifier.fillMaxWidth().height(1.dp).background(Color.White.copy(alpha = 0.1f)))
        Spacer(Modifier.height(4.dp))
        MenuItem("Switch profile", onSwitchProfile, Modifier.focusRequester(first))
        MenuItem("Sign out", onSignOut)
    }
}

@Composable
private fun MenuItem(text: String, onClick: () -> Unit, modifier: Modifier = Modifier) {
    FocusBox(onClick, modifier.fillMaxWidth(), focusedScale = 1f, ring = false) { focused ->
        Text(text, color = if (focused) Tokens.Bg else Tokens.Text, fontSize = 10.sp, fontWeight = FontWeight.SemiBold,
            modifier = Modifier.fillMaxWidth().background(if (focused) Tokens.Text else Color.Transparent).padding(horizontal = 9.dp, vertical = 6.dp))
    }
}
