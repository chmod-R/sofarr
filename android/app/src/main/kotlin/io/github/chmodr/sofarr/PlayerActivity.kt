@file:OptIn(UnstableApi::class)

package io.github.chmodr.sofarr

import android.media.MediaCodecInfo.CodecProfileLevel
import android.media.MediaCodecList
import android.os.Bundle
import android.util.Log
import android.view.WindowManager
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.lifecycle.lifecycleScope
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.MimeTypes
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.Tracks
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.ui.PlayerView
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

/**
 * Plays one movie or episode. Tries the original file first (direct play, no
 * work for the server); if this device can't decode its video or audio, asks
 * Sofarr for a Plex transcode instead and carries on from the same point.
 */
class PlayerActivity : ComponentActivity() {
    private lateinit var api: SofarrApi
    private lateinit var player: ExoPlayer
    private var session: PlayStart? = null
    private var fellBack = false
    private var heartbeat: Job? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val plexKey = intent.getStringExtra(EXTRA_PLEX_KEY)
        api = Sofarr.api(this) ?: return finish()
        if (plexKey == null) return finish()

        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        player = ExoPlayer.Builder(this).build()
        val view = PlayerView(this).apply {
            this.player = this@PlayerActivity.player
            setShowBuffering(PlayerView.SHOW_BUFFERING_ALWAYS)
            setShowNextButton(false)
            setShowPreviousButton(false)
            controllerShowTimeoutMs = 4_000
            keepScreenOn = true
        }
        setContentView(view)
        player.addListener(listener)

        lifecycleScope.launch {
            try {
                start(api.play(plexKey, direct = true, offsetMs = null, capabilities = null))
            } catch (e: Exception) {
                fail("Couldn't start playback (${e.message ?: e.javaClass.simpleName}).")
            }
        }
    }

    private fun start(s: PlayStart) {
        session = s
        Log.i(TAG, "playing ${s.mode}: ${s.title} ${s.subtitle.orEmpty()} media=${s.media} from ${s.startMs} ms")
        val item = MediaItem.Builder()
            .setUri(api.resolve(s.src))
            .apply { if (s.mode == "hls") setMimeType(MimeTypes.APPLICATION_M3U8) }
            .build()
        player.setMediaItem(item, s.startMs)
        player.prepare()
        player.play()
    }

    private val listener = object : Player.Listener {
        override fun onTracksChanged(tracks: Tracks) {
            if (session?.mode != "direct" || fellBack) return
            // ExoPlayer quietly skips tracks it can't decode; with no usable video or audio, convert instead.
            val missing = listOf(C.TRACK_TYPE_VIDEO to "video", C.TRACK_TYPE_AUDIO to "audio").filter { (type, _) ->
                val groups = tracks.groups.filter { it.type == type }
                groups.isNotEmpty() && groups.none { it.isSupported }
            }
            if (missing.isNotEmpty()) fallBack("can't decode ${missing.joinToString { it.second }}")
        }

        override fun onPlayerError(error: PlaybackException) {
            if (session?.mode == "direct" && !fellBack) {
                fallBack(error.errorCodeName)
            } else {
                fail("Playback failed (${error.errorCodeName}).")
            }
        }

        override fun onIsPlayingChanged(isPlaying: Boolean) {
            heartbeat?.cancel()
            if (isPlaying) {
                heartbeat = lifecycleScope.launch {
                    while (isActive) {
                        report("playing")
                        delay(10_000)
                    }
                }
            } else if (player.playbackState == Player.STATE_READY) {
                report("paused")
            }
        }

        override fun onPlaybackStateChanged(state: Int) {
            if (state == Player.STATE_ENDED) finish()
        }
    }

    /** Switch to a Plex transcode at the current position. */
    private fun fallBack(reason: String) {
        val s = session ?: return
        fellBack = true
        val position = player.currentPosition.coerceAtLeast(s.startMs)
        Log.i(TAG, "direct play not possible ($reason); asking Plex to convert")
        player.stop()
        lifecycleScope.launch {
            try {
                runCatching { api.progress(s.id, position, "stopped") }
                start(api.play(s.ratingKey, direct = false, offsetMs = position, capabilities = deviceCapabilities()))
            } catch (e: Exception) {
                fail("Couldn't start playback (${e.message ?: e.javaClass.simpleName}).")
            }
        }
    }

    private fun report(state: String) {
        val s = session ?: return
        val position = player.currentPosition
        lifecycleScope.launch { runCatching { api.progress(s.id, position, state) } }
    }

    private fun fail(message: String) {
        Toast.makeText(this, message, Toast.LENGTH_LONG).show()
        finish()
    }

    override fun onStop() {
        super.onStop()
        if (!::player.isInitialized) return
        heartbeat?.cancel()
        val s = session
        val position = player.currentPosition
        session = null
        player.release()
        // Tell Plex where we stopped, even though this screen is going away.
        if (s != null) CoroutineScope(Dispatchers.IO).launch { runCatching { api.progress(s.id, position, "stopped") } }
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
