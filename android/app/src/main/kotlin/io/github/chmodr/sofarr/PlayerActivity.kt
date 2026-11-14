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
import androidx.media3.common.TrackSelectionOverride
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
    private var audioChosen = false
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
            val s = session ?: return
            if (s.mode != "direct" || fellBack) return
            // ExoPlayer quietly skips tracks it can't decode: check the video, and that the audio
            // track chosen in Plex (not just any track) can play. Otherwise convert instead.
            val video = tracks.groups.filter { it.type == C.TRACK_TYPE_VIDEO }
            if (video.isNotEmpty() && video.none { it.isSupported }) return fallBack("can't decode the video")
            if (!audioChosen) chooseAudio(s, tracks)
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

    /**
     * Play the audio track selected in Plex (per profile, as Plex's own apps do). Plex lists a
     * file's audio streams in file order, as ExoPlayer does, so they line up by position.
     */
    private fun chooseAudio(s: PlayStart, tracks: Tracks) {
        val groups = tracks.groups.filter { it.type == C.TRACK_TYPE_AUDIO }
        if (groups.isEmpty()) return
        audioChosen = true
        val plexAudio = s.tracks?.audio.orEmpty()
        val wanted = plexAudio.indexOfFirst { it.selected }.takeIf { it >= 0 } ?: 0
        val group = if (groups.size == plexAudio.size) groups[wanted] else null
        if (group == null) {
            // Can't line them up: accept ExoPlayer's choice if it found anything playable.
            if (groups.none { it.isSupported }) fallBack("can't decode the audio")
            return
        }
        if (!group.isTrackSupported(0)) {
            return fallBack("can't decode audio track \"${plexAudio[wanted].label}\" (${group.getTrackFormat(0).sampleMimeType})")
        }
        if (!group.isSelected) {
            player.trackSelectionParameters = player.trackSelectionParameters.buildUpon()
                .setOverrideForType(TrackSelectionOverride(group.mediaTrackGroup, 0))
                .build()
        }
        Log.i(TAG, "audio: ${plexAudio[wanted].label} (${group.getTrackFormat(0).sampleMimeType})")
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
