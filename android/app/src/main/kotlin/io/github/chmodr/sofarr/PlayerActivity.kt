@file:OptIn(UnstableApi::class)

package io.github.chmodr.sofarr

import android.media.MediaCodecInfo.CodecProfileLevel
import android.media.MediaCodecList
import android.os.Bundle
import android.util.Log
import android.view.KeyEvent as AndroidKey
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.focusable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ColorFilter
import androidx.compose.ui.graphics.Shadow
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.addPathNodes
import androidx.compose.ui.graphics.vector.rememberVectorPainter
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.nativeKeyCode
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.lifecycleScope
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.MimeTypes
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.TrackSelectionOverride
import androidx.media3.common.Tracks
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.ui.PlayerView
import androidx.tv.material3.Text
import coil3.compose.AsyncImage
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

private const val PROGRESS_MS = 10_000L
private const val CONTROLS_HIDE_MS = 3_500L
private const val SEEK_S = 10L
private const val UP_NEXT_S = 10
/** Paused and untouched this long: show what's playing instead of the controls. */
private const val PAUSED_IDLE_MS = 6_000L
/** The button row gives the keys back to the video when left alone. */
private const val ROW_IDLE_MS = 8_000L

private enum class RowButton(val label: String) { Restart("Start over"), Next("Next episode"), Tracks("Audio & Subtitles") }

/** One entry in the Audio & Subtitles panel (subtitle id 0 = off). */
private data class Choice(val subtitle: Boolean, val id: Int, val label: String, val note: String?, val selected: Boolean)

private data class Skip(val dir: Int, val totalS: Long, val n: Int)

/**
 * Plays one movie or episode, with the web player's controls and keys. Tries the original
 * file first (direct play: no work for the server, and audio / embedded subtitles switch
 * instantly); when this device can't decode it, or the chosen subtitles have to be drawn by
 * Plex, it asks Sofarr for a Plex transcode and carries on from the same point.
 */
class PlayerActivity : ComponentActivity() {
    private lateinit var api: SofarrApi
    private lateinit var player: ExoPlayer

    // What the screen shows.
    private var session by mutableStateOf<PlayStart?>(null)
    private var paused by mutableStateOf(true)
    private var buffering by mutableStateOf(true)
    private var timeMs by mutableLongStateOf(0L)
    private var controls by mutableStateOf(true)
    private var activity by mutableIntStateOf(0) // bumps on every key: restarts the idle timers
    private var row by mutableStateOf<RowButton?>(null)
    private var panel by mutableStateOf<Pair<Int, Int>?>(null) // column (0 audio, 1 subtitles), row
    private var upNext by mutableStateOf<Int?>(null)
    private var upNextChoice by mutableIntStateOf(0) // 0 play now, 1 cancel
    private var skipped by mutableStateOf<Skip?>(null)
    private var pausedIdle by mutableStateOf(false)
    private var switching by mutableStateOf<String?>(null)
    private var error by mutableStateOf<String?>(null)

    /** Direct play turned out impossible for this title: the rest of it plays through Plex. */
    private var fellBack = false
    private var tracksApplied = false
    private var stopped = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val plexKey = intent.getStringExtra(EXTRA_PLEX_KEY)
        api = Sofarr.api(this) ?: return finish()
        if (plexKey == null) return finish()

        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        player = ExoPlayer.Builder(this).build()
        player.addListener(listener)
        setContent { SofarrTheme { PlayerScreen() } }
        open(plexKey)
    }

    // ---- Playback ----

    /** Start a movie or episode (Plex decides where to resume). */
    private fun open(plexKey: String) {
        fellBack = false
        stopped = false
        upNext = null
        lifecycleScope.launch {
            try {
                begin(api.play(plexKey, direct = true, offsetMs = null, capabilities = null), null)
            } catch (e: Exception) {
                error = "Couldn't start playback (${e.message ?: e.javaClass.simpleName})."
            }
        }
    }

    private fun begin(s: PlayStart, atMs: Long?) {
        session = s
        tracksApplied = false
        val start = atMs ?: s.startMs
        Log.i(TAG, "playing ${s.mode}: ${s.title} ${s.subtitle.orEmpty()} media=${s.media} decision=${s.decision} from $start ms")
        val item = MediaItem.Builder()
            .setUri(api.resolve(s.src))
            .apply { if (s.mode == "hls") setMimeType(MimeTypes.APPLICATION_M3U8) }
            .build()
        // Plex burns subtitles into HLS; text tracks only ever come from the file in direct play.
        player.trackSelectionParameters = player.trackSelectionParameters.buildUpon()
            .clearOverrides()
            .setTrackTypeDisabled(C.TRACK_TYPE_TEXT, s.mode != "direct")
            .build()
        player.setMediaItem(item, start)
        player.prepare()
        player.play()
        timeMs = start
    }

    private val listener = object : Player.Listener {
        override fun onTracksChanged(tracks: Tracks) {
            val s = session ?: return
            if (s.mode != "direct" || tracksApplied || tracks.groups.isEmpty()) return
            tracksApplied = true
            // ExoPlayer quietly skips tracks it can't decode: check them ourselves.
            val video = tracks.groups.filter { it.type == C.TRACK_TYPE_VIDEO }
            if (video.isNotEmpty() && video.none { it.isSupported }) return fallBack("can't decode the video")
            applyTracks(s, tracks)
        }

        override fun onPlayerError(e: PlaybackException) {
            if (session?.mode == "direct" && !fellBack) fallBack(e.errorCodeName)
            else error = "Playback failed (${e.errorCodeName})."
        }

        override fun onIsPlayingChanged(isPlaying: Boolean) {
            paused = !player.playWhenReady
            if (!isPlaying && player.playbackState == Player.STATE_READY) report("paused")
        }

        override fun onPlayWhenReadyChanged(playWhenReady: Boolean, reason: Int) {
            paused = !playWhenReady
        }

        override fun onPlaybackStateChanged(state: Int) {
            buffering = state == Player.STATE_BUFFERING || state == Player.STATE_IDLE
            if (state == Player.STATE_ENDED) {
                report("stopped")
                stopped = true
                if (session?.next != null) {
                    upNextChoice = 0
                    upNext = UP_NEXT_S
                } else {
                    finish()
                }
            }
        }
    }

    /** ExoPlayer's track group for a Plex stream: by its position in the file, else by order. */
    private fun groupFor(tracks: Tracks, type: Int, all: List<PlayTrack>, t: PlayTrack): Tracks.Group? {
        val groups = tracks.groups.filter { g ->
            g.type == type && g.getTrackFormat(0).sampleMimeType.let { it != MimeTypes.APPLICATION_CEA608 && it != MimeTypes.APPLICATION_CEA708 }
        }
        t.index?.let { idx ->
            groups.firstOrNull { it.getTrackFormat(0).id?.substringAfterLast(':') == "${idx + 1}" }?.let { return it }
        }
        val inFile = all.filter { !it.external && it.index != null }
        val at = inFile.indexOf(t)
        return if (at >= 0 && groups.size == inFile.size) groups[at] else null
    }

    /** Play the audio and subtitles selected in Plex (per profile, as Plex's own apps do). */
    private fun applyTracks(s: PlayStart, tracks: Tracks) {
        val params = player.trackSelectionParameters.buildUpon()
        val audio = s.tracks?.audio.orEmpty()
        val a = audio.firstOrNull { it.selected } ?: audio.firstOrNull()
        val audioGroups = tracks.groups.filter { it.type == C.TRACK_TYPE_AUDIO }
        if (a != null && audioGroups.isNotEmpty()) {
            val g = groupFor(tracks, C.TRACK_TYPE_AUDIO, audio, a)
            when {
                g == null && audioGroups.none { it.isSupported } -> return fallBack("can't decode the audio")
                g != null && !g.isTrackSupported(0) -> return fallBack("can't decode audio \"${a.label}\" (${g.getTrackFormat(0).sampleMimeType})")
                g != null -> params.setOverrideForType(TrackSelectionOverride(g.mediaTrackGroup, 0))
            }
        }
        val subs = s.tracks?.subtitles.orEmpty()
        val sub = subs.firstOrNull { it.selected }
        if (sub == null) {
            params.setTrackTypeDisabled(C.TRACK_TYPE_TEXT, true)
        } else {
            val g = groupFor(tracks, C.TRACK_TYPE_TEXT, subs, sub)
            if (g == null || !g.isTrackSupported(0)) return fallBack("subtitles \"${sub.label}\" need Plex")
            params.setTrackTypeDisabled(C.TRACK_TYPE_TEXT, false).setOverrideForType(TrackSelectionOverride(g.mediaTrackGroup, 0))
        }
        player.trackSelectionParameters = params.build()
    }

    /** Switch to a Plex transcode at the current position. */
    private fun fallBack(reason: String) {
        val s = session ?: return
        fellBack = true
        val position = player.currentPosition.coerceAtLeast(0)
        Log.i(TAG, "direct play not possible ($reason); asking Plex to convert")
        player.stop()
        lifecycleScope.launch {
            try {
                runCatching { api.progress(s.id, position, "stopped") }
                begin(api.play(s.ratingKey, direct = false, offsetMs = position, capabilities = deviceCapabilities()), position)
            } catch (e: Exception) {
                error = "Couldn't start playback (${e.message ?: e.javaClass.simpleName})."
            }
        }
    }

    private fun report(state: String) {
        val s = session ?: return
        val position = player.currentPosition
        lifecycleScope.launch { runCatching { api.progress(s.id, position, state) } }
    }

    // ---- Actions (the web player's) ----

    private fun showControls() {
        controls = true
        pausedIdle = false
        activity++
    }

    private fun toggle() {
        if (player.playWhenReady) player.pause() else player.play()
        showControls()
    }

    private fun seekBy(deltaMs: Long) {
        val s = session ?: return
        val max = (s.durationMs.takeIf { it > 0 } ?: player.duration).coerceAtLeast(0)
        val to = (player.currentPosition + deltaMs).coerceIn(0, (max - 1000).coerceAtLeast(0))
        player.seekTo(to)
        timeMs = to
        showControls()
    }

    /** A ←/→ skip: seeks, and shows the running total while presses keep coming. */
    private fun skip(dir: Int, seconds: Long = SEEK_S) {
        seekBy(dir * seconds * 1000)
        val k = skipped
        skipped = Skip(dir, (if (k?.dir == dir) k.totalS else 0) + seconds, (k?.n ?: 0) + 1)
    }

    private fun playNext() {
        val next = session?.next ?: return
        if (!stopped) report("stopped")
        stopped = true
        player.stop()
        session = null
        open(next.plexKey)
    }

    private fun exit() = finish()

    private fun rowButtons(): List<RowButton> = listOfNotNull(RowButton.Restart, RowButton.Next.takeIf { session?.next != null }, RowButton.Tracks)

    private fun press(b: RowButton) {
        showControls()
        when (b) {
            RowButton.Restart -> seekBy(-player.currentPosition)
            RowButton.Next -> playNext()
            RowButton.Tracks -> openPanel()
        }
    }

    private fun choices(s: PlayStart): Pair<List<Choice>, List<Choice>> {
        val t = s.tracks ?: PlayTracks()
        val audio = t.audio.map { Choice(false, it.id, it.label, null, it.selected) }
        val subs = listOf(Choice(true, 0, "Off", null, t.subtitles.none { it.selected })) +
            t.subtitles.map { Choice(true, it.id, it.label, if (it.forced) "forced" else null, it.selected) }
        return audio to subs
    }

    private fun openPanel() {
        val s = session ?: return
        val (audio, subs) = choices(s)
        // Start where there's a real choice: subtitles if there are any, else audio.
        val col = if (subs.size > 1 || audio.size <= 1) 1 else 0
        val list = if (col == 0) audio else subs
        panel = col to list.indexOfFirst { it.selected }.coerceAtLeast(0)
        row = null
        controls = true
    }

    /** Switch audio or subtitles: instantly in the file (direct play), else Plex restarts the stream. */
    private fun choose(c: Choice) {
        val s = session ?: return
        panel = null
        if (c.selected) return
        val at = player.currentPosition
        val audioId = if (c.subtitle) null else c.id
        val subId = if (c.subtitle) c.id else null
        lifecycleScope.launch {
            try {
                if (s.mode == "direct") {
                    // Remember the choice in Plex, then switch in the player if it can.
                    val saved = api.tracksDirect(s.id, audioId, subId, at)
                    val updated = s.copy(tracks = saved.tracks ?: s.tracks)
                    session = updated
                    val tracks = player.currentTracks
                    val all = if (c.subtitle) updated.tracks?.subtitles.orEmpty() else updated.tracks?.audio.orEmpty()
                    val t = all.firstOrNull { it.id == c.id }
                    val type = if (c.subtitle) C.TRACK_TYPE_TEXT else C.TRACK_TYPE_AUDIO
                    val g = t?.let { groupFor(tracks, type, all, it) }
                    when {
                        c.subtitle && c.id == 0 -> player.trackSelectionParameters = player.trackSelectionParameters.buildUpon()
                            .setTrackTypeDisabled(C.TRACK_TYPE_TEXT, true).build()
                        g != null && g.isTrackSupported(0) -> player.trackSelectionParameters = player.trackSelectionParameters.buildUpon()
                            .setTrackTypeDisabled(type, false)
                            .setOverrideForType(TrackSelectionOverride(g.mediaTrackGroup, 0)).build()
                        else -> {
                            // Not playable here (a sidecar subtitle file, or a format this device can't do): Plex converts.
                            switching = if (c.subtitle) "Turning on subtitles…" else "Switching audio…"
                            fallBack(if (c.subtitle) "subtitles \"${c.label}\" need Plex" else "can't decode audio \"${c.label}\"")
                        }
                    }
                } else {
                    switching = if (!c.subtitle) "Switching audio…" else if (c.id != 0) "Turning on subtitles…" else "Turning off subtitles…"
                    begin(api.tracksHls(s.id, audioId, subId, at), at)
                }
            } catch (e: Exception) {
                error = "Couldn't switch tracks."
            } finally {
                delay(1500)
                switching = null
            }
        }
    }

    /** All the remote's keys, like the web player's keydown handler. Back is handled separately. */
    private fun onKey(code: Int): Boolean {
        val p = panel
        val s = session
        if (error != null) {
            if (code == AndroidKey.KEYCODE_DPAD_CENTER || code == AndroidKey.KEYCODE_ENTER) exit()
            return true
        }
        if (p != null && s != null) {
            val (audio, subs) = choices(s)
            val columns = listOf(audio, subs)
            val list = columns[p.first]
            when (code) {
                AndroidKey.KEYCODE_DPAD_UP -> panel = p.first to (p.second - 1).coerceAtLeast(0)
                AndroidKey.KEYCODE_DPAD_DOWN -> panel = p.first to (p.second + 1).coerceAtMost(list.size - 1)
                AndroidKey.KEYCODE_DPAD_LEFT, AndroidKey.KEYCODE_DPAD_RIGHT -> {
                    val col = 1 - p.first
                    if (columns[col].isNotEmpty()) panel = col to columns[col].indexOfFirst { it.selected }.coerceAtLeast(0)
                }
                AndroidKey.KEYCODE_DPAD_CENTER, AndroidKey.KEYCODE_ENTER -> list.getOrNull(p.second)?.let(::choose)
            }
            return true
        }
        val r = row
        if (r != null && upNext == null) {
            val buttons = rowButtons()
            val at = buttons.indexOf(r)
            when (code) {
                AndroidKey.KEYCODE_DPAD_UP -> row = null
                AndroidKey.KEYCODE_DPAD_LEFT -> row = buttons[(at - 1).coerceAtLeast(0)]
                AndroidKey.KEYCODE_DPAD_RIGHT -> row = buttons[(at + 1).coerceAtMost(buttons.size - 1)]
                AndroidKey.KEYCODE_DPAD_CENTER, AndroidKey.KEYCODE_ENTER -> press(r)
            }
            showControls()
            return true
        }
        if (upNext != null) {
            when (code) {
                AndroidKey.KEYCODE_DPAD_LEFT, AndroidKey.KEYCODE_DPAD_RIGHT -> upNextChoice = 1 - upNextChoice
                AndroidKey.KEYCODE_DPAD_CENTER, AndroidKey.KEYCODE_ENTER -> if (upNextChoice == 0) playNext() else exit()
            }
            return true
        }
        when (code) {
            AndroidKey.KEYCODE_DPAD_CENTER, AndroidKey.KEYCODE_ENTER, AndroidKey.KEYCODE_MEDIA_PLAY_PAUSE, AndroidKey.KEYCODE_SPACE -> toggle()
            AndroidKey.KEYCODE_MEDIA_PLAY -> { player.play(); showControls() }
            AndroidKey.KEYCODE_MEDIA_PAUSE -> { player.pause(); showControls() }
            AndroidKey.KEYCODE_DPAD_RIGHT -> skip(1)
            AndroidKey.KEYCODE_DPAD_LEFT -> skip(-1)
            AndroidKey.KEYCODE_MEDIA_FAST_FORWARD -> skip(1, 30)
            AndroidKey.KEYCODE_MEDIA_REWIND -> skip(-1, 30)
            AndroidKey.KEYCODE_MEDIA_NEXT -> playNext()
            AndroidKey.KEYCODE_DPAD_DOWN -> { if (s != null) row = RowButton.Tracks; showControls() }
            AndroidKey.KEYCODE_DPAD_UP -> showControls()
            else -> return false
        }
        return true
    }

    // ---- Screen ----

    @Composable
    private fun PlayerScreen() {
        val focus = remember { FocusRequester() }
        LaunchedEffect(Unit) { focus.requestFocus() }

        // Position, read from the player a few times a second.
        LaunchedEffect(Unit) {
            while (isActive) {
                if (session != null && !buffering) timeMs = player.currentPosition
                delay(250)
            }
        }
        // Heartbeat to Plex (resume point, watched status, keeps the stream alive).
        LaunchedEffect(session?.id) {
            if (session == null) return@LaunchedEffect
            while (isActive) {
                delay(PROGRESS_MS)
                if (!stopped) report(if (player.isPlaying) "playing" else "paused")
            }
        }
        // Controls fade away while playing.
        LaunchedEffect(controls, paused, row, panel, activity) {
            if (controls && !paused && row == null && panel == null) {
                delay(CONTROLS_HIDE_MS)
                controls = false
            }
        }
        // Paused and left alone: "what's playing".
        LaunchedEffect(paused, session, buffering, error, activity) {
            pausedIdle = false
            if (paused && session != null && !buffering && error == null) {
                delay(PAUSED_IDLE_MS)
                pausedIdle = true
            }
        }
        LaunchedEffect(row, activity) {
            if (row != null) {
                delay(ROW_IDLE_MS)
                row = null
            }
        }
        LaunchedEffect(skipped?.n) {
            if (skipped != null) {
                delay(900)
                skipped = null
            }
        }
        // Up-next countdown at the end of an episode.
        LaunchedEffect(upNext) {
            val n = upNext ?: return@LaunchedEffect
            if (n <= 0) return@LaunchedEffect playNext()
            delay(1000)
            if (upNext == n) upNext = n - 1
        }

        BackHandler {
            when {
                panel != null -> panel = null
                row != null -> row = null
                else -> exit() // also during "Up next": the episode is over, so leave
            }
        }

        val s = session
        val visible = (controls || paused || panel != null || row != null) && !pausedIdle && upNext == null
        Box(
            Modifier.fillMaxSize().background(Color.Black)
                .focusRequester(focus)
                .onPreviewKeyEvent { e ->
                    if (e.type != KeyEventType.KeyDown || e.key.nativeKeyCode == AndroidKey.KEYCODE_BACK) false
                    else onKey(e.key.nativeKeyCode)
                }
                .focusable(),
        ) {
            AndroidView(
                factory = { ctx ->
                    PlayerView(ctx).apply {
                        useController = false
                        setShowBuffering(PlayerView.SHOW_BUFFERING_NEVER)
                        keepScreenOn = true
                        player = this@PlayerActivity.player
                    }
                },
                modifier = Modifier.fillMaxSize(),
            )

            AnimatedVisibility(visible, enter = fadeIn(tween(200)), exit = fadeOut(tween(200)), modifier = Modifier.fillMaxSize()) {
                Box(Modifier.fillMaxSize()) {
                    TopBar(s)
                    if (s != null && error == null) Center(Modifier.align(Alignment.Center))
                    BottomBar(s, Modifier.align(Alignment.BottomCenter))
                }
            }
            if ((buffering || switching != null) && error == null && upNext == null) Spinner(Modifier.align(Alignment.Center))
            if (pausedIdle && s != null) IdleScreen(s)
            if (panel != null && s != null) TracksPanel(s, Modifier.align(Alignment.BottomEnd))
            switching?.let {
                Text(it, color = Tokens.Text, fontWeight = FontWeight.SemiBold, fontSize = 10.sp,
                    modifier = Modifier.align(Alignment.Center).offset(y = 28.dp).clip(RoundedCornerShape(50))
                        .background(Color.Black.copy(alpha = 0.7f)).padding(horizontal = 9.dp, vertical = 4.dp))
            }
            val next = s?.next
            val countdown = upNext
            if (countdown != null && next != null) UpNext(next, countdown, Modifier.align(Alignment.BottomEnd))
            error?.let { ErrorOverlay(it) }
        }
    }

    @Composable
    private fun TopBar(s: PlayStart?) {
        Column(
            Modifier.fillMaxWidth()
                .background(Brush.verticalGradient(listOf(Color.Black.copy(alpha = 0.75f), Color.Transparent)))
                .padding(horizontal = Tokens.Gutter, vertical = 15.dp),
        ) {
            Text(s?.title ?: "Loading…", color = Tokens.Text, fontSize = 15.sp, fontWeight = FontWeight.Bold)
            s?.subtitle?.let { Text(it, color = Tokens.Sub, fontSize = 10.sp) }
        }
    }

    /** Centre: back 10 · play/pause · forward 10. */
    @Composable
    private fun Center(modifier: Modifier) {
        Row(modifier, horizontalArrangement = Arrangement.spacedBy(60.dp), verticalAlignment = Alignment.CenterVertically) {
            SkipButton(-1)
            Box(Modifier.size(60.dp).clip(CircleShape).background(Color.Black.copy(alpha = 0.45f)), contentAlignment = Alignment.Center) {
                if (!buffering && switching == null) {
                    Image(rememberVectorPainter(if (paused) PlayIcon else PauseIcon), null, Modifier.size(32.dp),
                        colorFilter = ColorFilter.tint(Tokens.Text))
                }
            }
            SkipButton(1)
        }
    }

    @Composable
    private fun SkipButton(dir: Int) {
        val k = skipped
        val hit = k?.dir == dir
        Box(contentAlignment = Alignment.Center) {
            Box(Modifier.size(40.dp).clip(CircleShape).background(if (hit) Color.White.copy(alpha = 0.25f) else Color.Black.copy(alpha = 0.45f)),
                contentAlignment = Alignment.Center) {
                Image(rememberVectorPainter(SkipArrow), null, Modifier.size(25.dp).graphicsLayer { scaleX = if (dir == 1) -1f else 1f },
                    colorFilter = ColorFilter.tint(Tokens.Text))
                Text("10", color = Tokens.Text, fontSize = 6.5.sp, fontWeight = FontWeight.Bold, modifier = Modifier.offset(y = 2.dp))
            }
            if (hit && k != null) {
                Text("${if (dir < 0) "−" else "+"}${k.totalS} s", color = Tokens.Text, fontWeight = FontWeight.Bold, fontSize = 10.sp,
                    style = TextStyle(shadow = Shadow(Color.Black.copy(alpha = 0.8f), blurRadius = 4f)),
                    modifier = Modifier.offset(y = 34.dp))
            }
        }
    }

    @Composable
    private fun BottomBar(s: PlayStart?, modifier: Modifier) {
        val duration = s?.durationMs ?: 0
        val pct = if (duration > 0) (timeMs.toFloat() / duration).coerceIn(0f, 1f) else 0f
        Column(
            modifier.fillMaxWidth()
                .background(Brush.verticalGradient(listOf(Color.Transparent, Color.Black.copy(alpha = 0.85f))))
                .padding(horizontal = Tokens.Gutter, vertical = 15.dp),
        ) {
            // Position: elapsed · bar · remaining.
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                TimeText(clock(timeMs))
                Box(Modifier.weight(1f).height(16.dp), contentAlignment = Alignment.CenterStart) {
                    Box(Modifier.fillMaxWidth().height(3.dp).clip(RoundedCornerShape(50)).background(Color.White.copy(alpha = 0.28f))) {
                        Box(Modifier.fillMaxHeight().fillMaxWidth(pct).background(Tokens.Accent))
                    }
                    Canvas(Modifier.fillMaxWidth().height(16.dp)) {
                        drawCircle(Color.Black.copy(alpha = 0.4f), radius = 6.dp.toPx(), center = Offset(size.width * pct, size.height / 2))
                        drawCircle(Tokens.Accent, radius = 4.75.dp.toPx(), center = Offset(size.width * pct, size.height / 2))
                    }
                }
                TimeText("−" + clock((duration - timeMs).coerceAtLeast(0)))
            }
            Spacer(Modifier.height(5.dp))
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.5.dp)) {
                Text(
                    if (row != null) "← → choose · Enter select · ↑ back to video" else "← → 10 s · Enter ${if (paused) "play" else "pause"} · ↓ more · Back exit",
                    color = Tokens.Muted, fontSize = 8.5.sp, modifier = Modifier.weight(1f),
                )
                if (s != null) {
                    Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                        rowButtons().forEach { b -> FakeButton(b.label, focused = row == b, quiet = true, open = b == RowButton.Tracks && panel != null) }
                    }
                    val converting = s.mode == "hls" && (s.decision?.video == "transcode" || s.decision?.audio == "transcode")
                    StatusPill(if (converting) "requested" else "owned", if (converting) "Converting" else if (s.mode == "direct") "Direct play" else "Direct stream")
                }
            }
        }
    }

    @Composable
    private fun TimeText(text: String) =
        Text(text, color = Tokens.Text, fontWeight = FontWeight.SemiBold, fontSize = 10.sp, modifier = Modifier.widthIn(min = 36.dp),
            style = TextStyle(fontFeatureSettings = "tnum"), textAlign = TextAlign.Center)

    @Composable
    private fun Spinner(modifier: Modifier) {
        val angle by rememberInfiniteTransition(label = "spin").animateFloat(0f, 360f,
            infiniteRepeatable(tween(900, easing = LinearEasing), RepeatMode.Restart), label = "spin-angle")
        Canvas(modifier.size(35.dp).rotate(angle)) {
            val w = 3.dp.toPx()
            drawCircle(Color.White.copy(alpha = 0.2f), radius = size.minDimension / 2 - w / 2, style = Stroke(w))
            drawArc(Tokens.Accent, -90f, 90f, false, topLeft = Offset(w / 2, w / 2), size = Size(size.width - w, size.height - w),
                style = Stroke(w, cap = StrokeCap.Round))
        }
    }

    /** Paused and left alone: what's playing, over a dimmed picture. */
    @Composable
    private fun IdleScreen(s: PlayStart) {
        Column(
            Modifier.fillMaxSize().background(Color.Black.copy(alpha = 0.78f)).padding(horizontal = Tokens.Gutter),
            verticalArrangement = Arrangement.spacedBy(5.dp, Alignment.CenterVertically),
        ) {
            Text("You're watching", color = Tokens.Muted, fontSize = 10.sp)
            Text(s.title, color = Tokens.Text, fontSize = 38.sp, fontWeight = FontWeight.ExtraBold, lineHeight = 1.05.em)
            s.subtitle?.let { Text(it, color = Tokens.Text, fontSize = 14.sp, fontWeight = FontWeight.SemiBold) }
            s.summary?.let {
                Text(it, color = Tokens.Overview, fontSize = 11.sp, maxLines = 4, overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.widthIn(max = 400.dp).padding(top = 6.dp, bottom = 10.dp))
            }
            Text("Paused", color = Tokens.Muted, fontSize = 8.5.sp)
        }
    }

    /** Audio & subtitles panel: two columns; the remote moves the highlight. */
    @Composable
    private fun TracksPanel(s: PlayStart, modifier: Modifier) {
        val (audio, subs) = choices(s)
        val p = panel ?: return
        Column(
            modifier.padding(end = Tokens.Gutter, bottom = 70.dp).width(440.dp).heightIn(max = 324.dp)
                .clip(RoundedCornerShape(Tokens.Radius)).background(Color(0xF214151B)).padding(12.5.dp),
        ) {
            Row(Modifier.weight(1f, fill = false), horizontalArrangement = Arrangement.spacedBy(15.dp)) {
                listOf("Audio" to audio, "Subtitles" to subs).forEachIndexed { col, (heading, list) ->
                    Column(Modifier.weight(1f).verticalScroll(rememberScrollState())) {
                        Text(heading.uppercase(), color = Tokens.Muted, fontSize = 10.sp, fontWeight = FontWeight.Bold, letterSpacing = 0.06.em,
                            modifier = Modifier.padding(bottom = 6.dp))
                        if (list.isEmpty()) Text("None", color = Tokens.Muted, fontSize = 8.5.sp)
                        list.forEachIndexed { i, c ->
                            val focused = p.first == col && p.second == i
                            Row(
                                Modifier.fillMaxWidth().clip(RoundedCornerShape(4.dp)).background(if (focused) Tokens.Text else Color.Transparent)
                                    .padding(horizontal = 6.dp, vertical = 5.dp),
                                horizontalArrangement = Arrangement.spacedBy(5.dp),
                            ) {
                                Text(if (c.selected) "✓" else "", color = if (focused) Tokens.Bg else Tokens.Accent, fontWeight = FontWeight.Bold,
                                    fontSize = 10.sp, modifier = Modifier.width(12.dp))
                                Text(c.label + (c.note?.let { " · $it" } ?: ""), color = if (focused) Tokens.Bg else Tokens.Text, fontSize = 10.sp)
                            }
                        }
                        if (col == 1 && list.size == 1) Text("No subtitles available for this title.", color = Tokens.Muted, fontSize = 8.5.sp,
                            modifier = Modifier.padding(start = 6.dp, top = 4.dp))
                        if (col == 0 && list.size == 1) Text("This is the only audio track.", color = Tokens.Muted, fontSize = 8.5.sp,
                            modifier = Modifier.padding(start = 6.dp, top = 4.dp))
                    }
                }
            }
            Text(
                if (s.mode == "direct") "Subtitles in the file show instantly. Others are drawn into the picture by your Plex server, which converts the video."
                else "Subtitles are drawn into the picture by your Plex server, so turning them on converts the video.",
                color = Tokens.Muted, fontSize = 8.5.sp, modifier = Modifier.padding(top = 8.dp),
            )
        }
    }

    @Composable
    private fun UpNext(next: NextEpisode, n: Int, modifier: Modifier) {
        Row(
            modifier.padding(end = Tokens.Gutter, bottom = 30.dp).width(400.dp).clip(RoundedCornerShape(Tokens.Radius))
                .background(Color(0xF214151B)),
        ) {
            Box(Modifier.weight(0.42f).heightIn(min = 90.dp).background(Tokens.BgRaised)) {
                next.thumb?.let { AsyncImage(model = api.resolve(it), contentDescription = null, contentScale = ContentScale.Crop, modifier = Modifier.matchParentSize()) }
                Box(Modifier.align(Alignment.BottomStart).fillMaxWidth().height(3.dp).background(Color.White.copy(alpha = 0.25f))) {
                    Box(Modifier.fillMaxHeight().fillMaxWidth((UP_NEXT_S - n).toFloat() / UP_NEXT_S).background(Tokens.Accent))
                }
            }
            Column(Modifier.weight(0.58f).padding(horizontal = 12.5.dp, vertical = 11.dp)) {
                Text("Next episode in $n", color = Tokens.Muted, fontSize = 8.5.sp)
                Text(next.subtitle ?: next.title, color = Tokens.Text, fontSize = 12.sp, fontWeight = FontWeight.Bold, modifier = Modifier.padding(top = 2.5.dp))
                Row(Modifier.padding(top = 10.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    FakeButton("▶ Play now", upNextChoice == 0, primary = true)
                    FakeButton("Cancel", upNextChoice == 1)
                }
            }
        }
    }

    /** A button in the web's style whose focus is managed by the player's own key handling. */
    @Composable
    private fun FakeButton(text: String, focused: Boolean, primary: Boolean = false, quiet: Boolean = false, open: Boolean = false) {
        val (bg, fg) = when {
            focused && primary -> Tokens.AccentFocused to Tokens.AccentInk
            focused -> Tokens.Text to Tokens.Bg
            primary -> Tokens.Accent to Tokens.AccentInk
            open -> Color.White.copy(alpha = 0.14f) to Tokens.Text
            quiet -> Color.Transparent to Tokens.Text
            else -> Color.White.copy(alpha = 0.12f) to Tokens.Text
        }
        Text(text, color = fg, fontSize = 10.sp, fontWeight = FontWeight.SemiBold,
            modifier = Modifier.graphicsLayer { scaleX = if (focused) 1.05f else 1f; scaleY = scaleX }
                .focusRing(focused, Tokens.Radius, gap = Color.Black)
                .clip(RoundedCornerShape(Tokens.Radius)).background(bg).padding(horizontal = 14.dp, vertical = 7.dp))
    }

    @Composable
    private fun BoxScope.ErrorOverlay(message: String) {
        Column(Modifier.matchParentSize().background(Color.Black.copy(alpha = 0.92f)), horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(12.5.dp, Alignment.CenterVertically)) {
            Text(message, color = Tokens.Text, fontSize = 11.sp)
            FakeButton("Back", focused = true, primary = true)
        }
    }

    override fun onStop() {
        super.onStop()
        if (!::player.isInitialized) return
        val s = session
        val position = player.currentPosition
        session = null
        player.release()
        // Tell Plex where we stopped, even though this screen is going away.
        if (s != null && !stopped) CoroutineScope(Dispatchers.IO).launch { runCatching { api.progress(s.id, position, "stopped") } }
        if (!isFinishing) finish()
    }

    /** What this device's decoders handle, so Plex only converts what it must. */
    private fun deviceCapabilities(): Capabilities {
        val decoders = MediaCodecList(MediaCodecList.REGULAR_CODECS).codecInfos.filter { !it.isEncoder }
        fun has(mime: String) = decoders.any { d -> d.supportedTypes.any { it.equals(mime, ignoreCase = true) } }
        val hevcMain10 = decoders.any { d ->
            d.supportedTypes.any { it.equals(MimeTypes.VIDEO_H265, true) } &&
                d.getCapabilitiesForType(MimeTypes.VIDEO_H265).profileLevels.any { it.profile == CodecProfileLevel.HEVCProfileMain10 }
        }
        return Capabilities(
            nativeHls = false, // fMP4 HLS, which ExoPlayer plays
            hevc = has(MimeTypes.VIDEO_H265),
            hevcMain10 = hevcMain10,
            eac3 = has(MimeTypes.AUDIO_E_AC3),
            ac3 = has(MimeTypes.AUDIO_AC3),
        )
    }

    companion object {
        const val EXTRA_PLEX_KEY = "plexKey"
        private const val TAG = "SofarrPlayer"
    }
}

private fun clock(ms: Long): String {
    val s = (ms / 1000).coerceAtLeast(0)
    val h = s / 3600
    val m = (s % 3600) / 60
    val sec = s % 60
    val mm = if (h > 0) "%02d".format(m) else "$m"
    return "${if (h > 0) "$h:" else ""}$mm:${"%02d".format(sec)}"
}

// The web player's icons (24 x 24 SVGs).
private val PlayIcon = ImageVector.Builder("play", 24.dp, 24.dp, 24f, 24f)
    .addPath(addPathNodes("M7 4.5v15a.8.8 0 0 0 1.2.7l12.5-7.5a.8.8 0 0 0 0-1.4L8.2 3.8A.8.8 0 0 0 7 4.5z"), fill = SolidColor(Color.White))
    .build()
private val PauseIcon = ImageVector.Builder("pause", 24.dp, 24.dp, 24f, 24f)
    .addPath(addPathNodes("M6.5 4h2.5a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-2.5a1 1 0 0 1-1-1v-14a1 1 0 0 1 1-1z"), fill = SolidColor(Color.White))
    .addPath(addPathNodes("M15 4h2.5a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-2.5a1 1 0 0 1-1-1v-14a1 1 0 0 1 1-1z"), fill = SolidColor(Color.White))
    .build()
/** A circular arrow (back); mirrored for forward. "10" is drawn over it. */
private val SkipArrow = ImageVector.Builder("skip", 24.dp, 24.dp, 24f, 24f)
    .addPath(addPathNodes("M5.2 8.5A8 8 0 1 1 4 13"), stroke = SolidColor(Color.White), strokeLineWidth = 1.8f,
        strokeLineCap = StrokeCap.Round, strokeLineJoin = StrokeJoin.Round)
    .addPath(addPathNodes("M5.6 3.8v4.9h4.9"), stroke = SolidColor(Color.White), strokeLineWidth = 1.8f,
        strokeLineCap = StrokeCap.Round, strokeLineJoin = StrokeJoin.Round)
    .build()
