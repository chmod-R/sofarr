package io.github.chmodr.sofarr

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.tv.material3.Button
import androidx.tv.material3.LocalContentColor
import androidx.tv.material3.MaterialTheme
import androidx.tv.material3.Text
import androidx.tv.material3.darkColorScheme
import kotlinx.coroutines.launch
import okhttp3.HttpUrl

private val Background = Color(0xFF0E0F13)
private val Accent = Color(0xFFF0A640)

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val settings = ServerSettings(this)
        setContent {
            MaterialTheme(colorScheme = darkColorScheme(primary = Accent, background = Background)) {
                // Text outside a tv-material Surface takes LocalContentColor, which defaults to black.
                CompositionLocalProvider(LocalContentColor provides Color(0xFFECEDF0)) {
                    Box(
                        Modifier.fillMaxSize().background(Background).padding(horizontal = 58.dp, vertical = 36.dp),
                        contentAlignment = Alignment.Center,
                    ) {
                        var server by remember { mutableStateOf(settings.url) }
                        val current = server
                        if (current == null) {
                            ServerSetup(initial = "") { settings.url = it; server = it }
                        } else {
                            Connected(current, onChangeServer = { settings.url = null; server = null })
                        }
                    }
                }
            }
        }
    }
}

/** First launch: ask where Sofarr is, and check it answers before saving. */
@Composable
private fun ServerSetup(initial: String, onSaved: (HttpUrl) -> Unit) {
    var text by remember { mutableStateOf(initial) }
    var message by remember { mutableStateOf<String?>(null) }
    var checking by remember { mutableStateOf(false) }
    var fieldFocused by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val focus = remember { FocusRequester() }

    fun connect() {
        val url = ServerSettings.parse(text)
        if (url == null) {
            message = "Enter the server address, for example 192.168.1.10:5656"
            return
        }
        checking = true
        message = "Connecting…"
        scope.launch {
            message = try {
                SofarrApi(url).health()
                onSaved(url)
                null
            } catch (e: Exception) {
                "Couldn't reach Sofarr at $url (${e.message ?: e.javaClass.simpleName})"
            } finally {
                checking = false
            }
        }
    }

    LaunchedEffect(Unit) { focus.requestFocus() }

    Column(Modifier.width(720.dp), verticalArrangement = Arrangement.spacedBy(20.dp)) {
        Text("Sofarr", style = MaterialTheme.typography.displaySmall, color = Accent)
        Text("Enter your Sofarr server's address.", style = MaterialTheme.typography.titleMedium)
        Row(horizontalArrangement = Arrangement.spacedBy(16.dp), verticalAlignment = Alignment.CenterVertically) {
            BasicTextField(
                value = text,
                onValueChange = { text = it },
                singleLine = true,
                textStyle = TextStyle(color = Color.White, fontSize = 22.sp),
                cursorBrush = SolidColor(Accent),
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri, imeAction = ImeAction.Go),
                keyboardActions = KeyboardActions(onGo = { connect() }),
                modifier = Modifier
                    .width(480.dp)
                    .focusRequester(focus)
                    .onFocusChanged { fieldFocused = it.isFocused }
                    .border(
                        BorderStroke(2.dp, if (fieldFocused) Accent else Color(0xFF3A3D46)),
                        RoundedCornerShape(8.dp),
                    )
                    .padding(horizontal = 16.dp, vertical = 12.dp),
                decorationBox = { inner ->
                    if (text.isEmpty()) Text("192.168.1.10:5656", color = Color(0xFF6B6F7A), fontSize = 22.sp)
                    inner()
                },
            )
            Button(onClick = { connect() }, enabled = !checking) { Text("Connect") }
        }
        message?.let { Text(it, style = MaterialTheme.typography.bodyLarge) }
    }
}

/** Placeholder until sign-in and Home are built: shows the server answers. */
@Composable
private fun Connected(server: HttpUrl, onChangeServer: () -> Unit) {
    var status by remember(server) { mutableStateOf("Connecting…") }
    val focus = remember { FocusRequester() }
    LaunchedEffect(server) {
        status = try {
            "Connected to Sofarr ${SofarrApi(server).health().version}"
        } catch (e: Exception) {
            "Couldn't reach Sofarr at $server (${e.message ?: e.javaClass.simpleName})"
        }
        focus.requestFocus()
    }
    Column(verticalArrangement = Arrangement.spacedBy(20.dp)) {
        Text("Sofarr", style = MaterialTheme.typography.displaySmall, color = Accent)
        Text(status, style = MaterialTheme.typography.titleMedium)
        Text("App ${BuildConfig.VERSION_NAME} · server $server", style = MaterialTheme.typography.bodyMedium)
        Button(onClick = onChangeServer, modifier = Modifier.focusRequester(focus)) { Text("Change server") }
    }
}
