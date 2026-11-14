package io.github.chmodr.sofarr

import android.content.Context
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.KSerializer
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import okhttp3.Cookie
import okhttp3.CookieJar
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.util.concurrent.TimeUnit

/** The Sofarr server address, entered at first launch and kept on the device. */
class ServerSettings(context: Context) {
    private val prefs = context.getSharedPreferences("server", Context.MODE_PRIVATE)

    var url: HttpUrl?
        get() = prefs.getString(KEY_URL, null)?.toHttpUrlOrNull()
        set(value) = prefs.edit().putString(KEY_URL, value?.toString()).apply()

    companion object {
        private const val KEY_URL = "url"

        /** Accepts "host:port" or a full URL; Sofarr is plain HTTP on the home network by default. */
        fun parse(input: String): HttpUrl? {
            val text = input.trim().trimEnd('/')
            if (text.isEmpty()) return null
            val withScheme = if ("://" in text) text else "http://$text"
            return withScheme.toHttpUrlOrNull()
        }
    }
}

/** Keeps Sofarr's session cookie across app restarts (it lasts 30 days, renewed while used). */
class PrefsCookieJar(context: Context) : CookieJar {
    private val prefs = context.getSharedPreferences("cookies", Context.MODE_PRIVATE)
    private val cookies = mutableListOf<Cookie>()
    private var loaded = false

    @Synchronized
    override fun saveFromResponse(url: HttpUrl, cookies: List<Cookie>) {
        load(url)
        for (c in cookies) {
            this.cookies.removeAll { it.name == c.name && it.domain == c.domain && it.path == c.path }
            if (c.expiresAt > System.currentTimeMillis()) this.cookies += c
        }
        prefs.edit()
            .putString("base", url.resolve("/").toString())
            .putStringSet("cookies", this.cookies.map { it.toString() }.toSet())
            .apply()
    }

    @Synchronized
    override fun loadForRequest(url: HttpUrl): List<Cookie> {
        load(url)
        val now = System.currentTimeMillis()
        cookies.removeAll { it.expiresAt <= now }
        return cookies.filter { it.matches(url) }
    }

    @Synchronized
    fun clear() {
        cookies.clear()
        prefs.edit().clear().apply()
    }

    private fun load(url: HttpUrl) {
        if (loaded) return
        loaded = true
        val base = prefs.getString("base", null)?.toHttpUrlOrNull() ?: url
        prefs.getStringSet("cookies", emptySet())!!.mapNotNullTo(cookies) { Cookie.parse(base, it) }
    }
}

class ApiException(val code: Int, val error: String?) : Exception("HTTP $code${error?.let { ": $it" } ?: ""}")

@Serializable data class Health(val status: String, val version: String)
@Serializable data class Session(val signedIn: Boolean, val profile: Profile? = null)
@Serializable data class Pin(val code: String, val linkUrl: String, val qrUrl: String? = null)
@Serializable data class PinStatus(val status: String, val reason: String? = null)
@Serializable data class Profile(val uuid: String, val title: String, val thumb: String? = null, val isProtected: Boolean = false)
@Serializable data class Profiles(val profiles: List<Profile>)
@Serializable data class Home(val rows: List<Row>)
@Serializable data class Row(val id: String, val title: String, val ranked: Boolean = false, val items: List<RowItem>)
@Serializable data class Resume(val plexKey: String, val label: String? = null, val percent: Int = 0)

@Serializable
data class RowItem(
    val id: String,
    val mediaType: String,
    val title: String,
    val year: Int? = null,
    val overview: String = "",
    val poster: String? = null,
    val backdrop: String? = null,
    val status: String,
    val plexKey: String? = null,
    val resume: Resume? = null,
    val availableFrom: String? = null,
) {
    /** What Play starts: the resume target, else the library item (a show plays its next-up episode). */
    val playKey: String? get() = resume?.plexKey ?: plexKey.takeIf { status == "owned" }
}

@Serializable
data class PlayStart(
    val id: String,
    val mode: String = "hls",
    val src: String,
    /** The movie or episode actually playing (a show resolves to its next-up episode). */
    val ratingKey: String,
    val title: String,
    val subtitle: String? = null,
    val durationMs: Long = 0,
    val startMs: Long = 0,
    val media: PlayMedia? = null,
    val tracks: PlayTracks? = null,
)

@Serializable data class PlayTracks(val audio: List<PlayTrack> = emptyList())
@Serializable data class PlayTrack(val id: Int, val label: String, val language: String? = null, val selected: Boolean = false)

@Serializable data class PlayMedia(val container: String? = null, val videoCodec: String? = null, val audioCodec: String? = null)

/** What this device decodes, for when Plex has to convert (same shape the web player sends). */
@Serializable
data class Capabilities(val nativeHls: Boolean, val hevc: Boolean, val hevcMain10: Boolean, val eac3: Boolean, val ac3: Boolean)

/** Sofarr's JSON API. One shared HTTP client, so the session cookie goes everywhere (artwork too). */
class SofarrApi(val base: HttpUrl, private val client: OkHttpClient) {
    fun resolve(path: String): String = base.resolve(path)?.toString() ?: path

    suspend fun health(): Health = get("/api/health", Health.serializer())
    suspend fun session(): Session = get("/api/auth/session", Session.serializer())
    suspend fun startPin(): Pin = post("/api/auth/pin", null, Pin.serializer())
    suspend fun profiles(): List<Profile> = get("/api/profiles", Profiles.serializer()).profiles
    suspend fun home(): Home = get("/api/home", Home.serializer())

    /** Poll the sign-in code. Plex's answer is in the body whatever the status code. */
    suspend fun pollPin(): PinStatus = withContext(Dispatchers.IO) {
        client.newCall(Request.Builder().url(base.resolve("/api/auth/pin")!!).build()).execute().use {
            json.decodeFromString(PinStatus.serializer(), it.body.string())
        }
    }

    suspend fun selectProfile(uuid: String, pin: String?) {
        val body = buildJsonObject { if (pin != null) put("pin", pin) }
        post("/api/profiles/$uuid/select", body, JsonObject.serializer())
    }

    suspend fun deselectProfile() {
        post("/api/profiles/deselect", null, JsonObject.serializer())
    }

    suspend fun signOut() {
        post("/api/auth/logout", null, JsonObject.serializer())
    }

    suspend fun play(plexKey: String, direct: Boolean, offsetMs: Long?, capabilities: Capabilities?): PlayStart {
        val body = buildJsonObject {
            put("plexKey", plexKey)
            put("mode", if (direct) "direct" else "hls")
            if (offsetMs != null) put("offsetMs", offsetMs)
            if (capabilities != null) put("capabilities", json.encodeToJsonElement(Capabilities.serializer(), capabilities))
        }
        return post("/api/play", body, PlayStart.serializer())
    }

    suspend fun progress(id: String, timeMs: Long, state: String) {
        val body = buildJsonObject {
            put("timeMs", timeMs)
            put("state", state)
        }
        post("/api/play/$id/progress", body, JsonObject.serializer())
    }

    private suspend fun <T> get(path: String, serializer: KSerializer<T>): T =
        call(Request.Builder().url(base.resolve(path)!!).build(), serializer)

    private suspend fun <T> post(path: String, body: JsonObject?, serializer: KSerializer<T>): T {
        val text = body?.toString() ?: "{}"
        val request = Request.Builder()
            .url(base.resolve(path)!!)
            .post(text.toRequestBody("application/json".toMediaType()))
            .build()
        return call(request, serializer)
    }

    private suspend fun <T> call(request: Request, serializer: KSerializer<T>): T = withContext(Dispatchers.IO) {
        client.newCall(request).execute().use { response ->
            val text = response.body.string()
            if (!response.isSuccessful) {
                val error = runCatching { json.decodeFromString(ErrorBody.serializer(), text).error }.getOrNull()
                throw ApiException(response.code, error)
            }
            json.decodeFromString(serializer, text)
        }
    }

    @Serializable private data class ErrorBody(val error: String? = null)

    companion object {
        val json = Json { ignoreUnknownKeys = true; explicitNulls = false }
    }
}

/** App-wide singletons: settings, the cookie jar and the HTTP client. */
object Sofarr {
    private var cookies: PrefsCookieJar? = null
    private var httpClient: OkHttpClient? = null

    @Synchronized
    fun client(context: Context): OkHttpClient = httpClient ?: OkHttpClient.Builder()
        .cookieJar(cookieJar(context))
        .connectTimeout(5, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS) // Home can wait on slow upstreams
        .build()
        .also { httpClient = it }

    @Synchronized
    fun cookieJar(context: Context): PrefsCookieJar =
        cookies ?: PrefsCookieJar(context.applicationContext).also { cookies = it }

    fun api(context: Context): SofarrApi? =
        ServerSettings(context).url?.let { SofarrApi(it, client(context)) }
}
