package io.github.chmodr.sofarr

import android.content.Context
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
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

@Serializable
data class Health(val status: String, val version: String)

class SofarrApi(private val base: HttpUrl) {
    private val json = Json { ignoreUnknownKeys = true }

    suspend fun health(): Health = withContext(Dispatchers.IO) {
        val request = Request.Builder().url(base.resolve("/api/health")!!).build()
        client.newCall(request).execute().use { response ->
            check(response.isSuccessful) { "HTTP ${response.code}" }
            json.decodeFromString(Health.serializer(), response.body.string())
        }
    }

    companion object {
        private val client = OkHttpClient.Builder()
            .connectTimeout(5, TimeUnit.SECONDS)
            .readTimeout(15, TimeUnit.SECONDS)
            .build()
    }
}
