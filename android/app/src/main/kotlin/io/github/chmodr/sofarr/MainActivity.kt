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
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
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
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ColorFilter
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.tv.material3.Button
import androidx.tv.material3.LocalContentColor
import androidx.tv.material3.MaterialTheme
import androidx.tv.material3.OutlinedButton
import androidx.tv.material3.Text
import androidx.tv.material3.darkColorScheme
import coil3.compose.AsyncImage
import coil3.compose.setSingletonImageLoaderFactory
import coil3.ImageLoader
import coil3.network.okhttp.OkHttpNetworkFetcherFactory
import coil3.request.crossfade
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import okhttp3.HttpUrl

val Background = Color(0xFF0E0F13)
val Accent = Color(0xFFF0A640)
val Muted = Color(0xFF9A9EA8)

/** Where the app is: one screen at a time, decided by what the server says about this session. */
private sealed interface Screen {
    data object Setup : Screen
    data object Loading : Screen
    data object SignIn : Screen
    data object Profiles : Screen
    data object Home : Screen
    data class Problem(val message: String) : Screen
}

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            setSingletonImageLoaderFactory { ctx ->
                ImageLoader.Builder(ctx)
                    .components { add(OkHttpNetworkFetcherFactory(callFactory = { Sofarr.client(ctx) })) }
                    .crossfade(true)
                    .build()
            }
            SofarrTheme { App() }
        }
    }
}

@Composable
fun SofarrTheme(content: @Composable () -> Unit) {
    MaterialTheme(colorScheme = darkColorScheme(primary = Accent, background = Background)) {
        // Text outside a tv-material Surface takes LocalContentColor, which defaults to black.
        CompositionLocalProvider(LocalContentColor provides Color(0xFFECEDF0)) {
            Box(Modifier.fillMaxSize().background(Background)) { content() }
        }
    }
}

@Composable
private fun App() {
    val context = LocalContext.current
    val settings = remember { ServerSettings(context) }
    var api by remember { mutableStateOf(Sofarr.api(context)) }
    var screen by remember { mutableStateOf<Screen>(if (api == null) Screen.Setup else Screen.Loading) }
    val scope = rememberCoroutineScope()

    /** Ask the server where this session stands and go there. */
    fun route() {
        val a = api ?: run { screen = Screen.Setup; return }
        screen = Screen.Loading
        scope.launch {
            screen = try {
                val s = a.session()
                if (s.profile != null) Screen.Home else Screen.Profiles
            } catch (e: ApiException) {
                if (e.code == 401) Screen.SignIn else Screen.Problem("Sofarr answered with an error (${e.message}).")
            } catch (e: Exception) {
                Screen.Problem("Couldn't reach Sofarr at ${a.base} (${e.message ?: e.javaClass.simpleName}).")
            }
        }
    }

    LaunchedEffect(Unit) { if (api != null) route() }

    when (val s = screen) {
        Screen.Setup -> ServerSetup { url ->
            settings.url = url
            Sofarr.cookieJar(context).clear()
            api = Sofarr.api(context)
            route()
        }
        Screen.Loading -> Centered { Text("Loading…", color = Muted) }
        Screen.SignIn -> SignIn(api!!, onSignedIn = { route() })
        Screen.Profiles -> ProfilePicker(api!!, onSelected = { screen = Screen.Home })
        Screen.Home -> HomeScreen(api!!, onSwitchProfile = {
            scope.launch {
                runCatching { api!!.deselectProfile() }
                screen = Screen.Profiles
            }
        })
        is Screen.Problem -> Centered {
            val focus = remember { FocusRequester() }
            LaunchedEffect(Unit) { focus.requestFocus() }
            Text(s.message, style = MaterialTheme.typography.titleMedium)
            Row(horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                Button(onClick = { route() }, modifier = Modifier.focusRequester(focus)) { Text("Try again") }
                OutlinedButton(onClick = { screen = Screen.Setup }) { Text("Change server") }
            }
        }
    }
}

@Composable
fun Centered(content: @Composable () -> Unit) {
    Box(Modifier.fillMaxSize().padding(horizontal = Edge, vertical = 27.dp), contentAlignment = Alignment.Center) {
        Column(verticalArrangement = Arrangement.spacedBy(14.dp), horizontalAlignment = Alignment.CenterHorizontally) {
            content()
        }
    }
}

/** First launch: ask where Sofarr is, and check it answers before saving. */
@Composable
private fun ServerSetup(onSaved: (HttpUrl) -> Unit) {
    var text by remember { mutableStateOf("") }
    var message by remember { mutableStateOf<String?>(null) }
    var checking by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val context = LocalContext.current

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
                SofarrApi(url, Sofarr.client(context)).health()
                onSaved(url)
                null
            } catch (e: Exception) {
                "Couldn't reach Sofarr at $url (${e.message ?: e.javaClass.simpleName})"
            } finally {
                checking = false
            }
        }
    }

    Centered {
        Text("Sofarr", style = MaterialTheme.typography.headlineLarge, color = Accent)
        Text("Enter your Sofarr server's address.", style = MaterialTheme.typography.titleMedium)
        Row(horizontalArrangement = Arrangement.spacedBy(16.dp), verticalAlignment = Alignment.CenterVertically) {
            TvTextField(text, { text = it }, "192.168.1.10:5656", KeyboardType.Uri, autoFocus = true, onDone = { connect() })
            Button(onClick = { connect() }, enabled = !checking) { Text("Connect") }
        }
        message?.let { Text(it, style = MaterialTheme.typography.bodyLarge) }
    }
}

@Composable
fun TvTextField(
    value: String,
    onValueChange: (String) -> Unit,
    placeholder: String,
    keyboardType: KeyboardType,
    autoFocus: Boolean = false,
    secret: Boolean = false,
    onDone: () -> Unit,
) {
    var focused by remember { mutableStateOf(false) }
    val focus = remember { FocusRequester() }
    if (autoFocus) LaunchedEffect(Unit) { focus.requestFocus() }
    BasicTextField(
        value = value,
        onValueChange = onValueChange,
        singleLine = true,
        textStyle = TextStyle(color = Color.White, fontSize = 16.sp),
        cursorBrush = SolidColor(Accent),
        visualTransformation = if (secret) PasswordVisualTransformation() else VisualTransformation.None,
        keyboardOptions = KeyboardOptions(keyboardType = keyboardType, imeAction = ImeAction.Go),
        keyboardActions = KeyboardActions(onGo = { onDone() }),
        modifier = Modifier
            .width(320.dp)
            .focusRequester(focus)
            .onFocusChanged { focused = it.isFocused }
            .border(BorderStroke(2.dp, if (focused) Accent else Color(0xFF3A3D46)), RoundedCornerShape(8.dp))
            .padding(horizontal = 12.dp, vertical = 9.dp),
        decorationBox = { inner ->
            if (value.isEmpty()) Text(placeholder, color = Color(0xFF6B6F7A), fontSize = 16.sp)
            inner()
        },
    )
}

/** Plex sign-in: show a code for plex.tv/link and wait until it's linked. */
@Composable
private fun SignIn(api: SofarrApi, onSignedIn: () -> Unit) {
    var pin by remember { mutableStateOf<Pin?>(null) }
    var message by remember { mutableStateOf<String?>(null) }
    var attempt by remember { mutableStateOf(0) }
    val focus = remember { FocusRequester() }

    LaunchedEffect(attempt) {
        pin = null
        message = null
        try {
            pin = api.startPin()
            while (true) {
                delay(2_000)
                val s = api.pollPin()
                when (s.status) {
                    "waiting" -> Unit
                    "signed_in" -> { onSignedIn(); return@LaunchedEffect }
                    "expired", "no_pending_login" -> { attempt++; return@LaunchedEffect }
                    "denied" -> { message = s.reason ?: "This Plex account can't sign in here."; break }
                    else -> { message = "Sign-in failed (${s.status})."; break }
                }
            }
        } catch (e: Exception) {
            message = "Couldn't start sign-in (${e.message ?: e.javaClass.simpleName})."
        }
        focus.requestFocus()
    }

    Centered {
        Text("Sign in with Plex", style = MaterialTheme.typography.headlineLarge, color = Accent)
        val p = pin
        if (p != null && message == null) {
            Row(horizontalArrangement = Arrangement.spacedBy(36.dp), verticalAlignment = Alignment.CenterVertically) {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("On your phone or computer, go to", style = MaterialTheme.typography.titleMedium)
                    Text("plex.tv/link", style = MaterialTheme.typography.headlineMedium, color = Accent)
                    Text("and enter this code:", style = MaterialTheme.typography.titleMedium)
                    Text(p.code, fontSize = 44.sp, letterSpacing = 6.sp)
                }
                p.qrUrl?.let {
                    // Plex's QR is white on transparent (made for dark screens): draw it black on white,
                    // with a quiet zone, which every phone camera reads.
                    AsyncImage(
                        model = it,
                        contentDescription = "QR code for plex.tv/link",
                        colorFilter = ColorFilter.tint(Color.Black),
                        modifier = Modifier.size(150.dp).clip(RoundedCornerShape(8.dp)).background(Color.White).padding(10.dp),
                    )
                }
            }
            Text("Only the owner of the Plex server can sign in.", color = Muted)
        } else if (message == null) {
            Text("Getting a code…", color = Muted)
        }
        message?.let {
            Text(it, style = MaterialTheme.typography.titleMedium)
            Button(onClick = { attempt++ }, modifier = Modifier.focusRequester(focus)) { Text("Try again") }
        }
    }
}

/** Plex Home users; protected ones ask for their PIN. */
@Composable
private fun ProfilePicker(api: SofarrApi, onSelected: () -> Unit) {
    var profiles by remember { mutableStateOf<List<Profile>?>(null) }
    var message by remember { mutableStateOf<String?>(null) }
    var askPin by remember { mutableStateOf<Profile?>(null) }
    var pin by remember { mutableStateOf("") }
    val scope = rememberCoroutineScope()
    val first = remember { FocusRequester() }

    LaunchedEffect(Unit) {
        try {
            profiles = api.profiles()
        } catch (e: Exception) {
            message = "Couldn't load profiles (${e.message ?: e.javaClass.simpleName})."
        }
    }
    LaunchedEffect(profiles, askPin) { if (profiles != null && askPin == null) runCatching { first.requestFocus() } }

    fun select(p: Profile, code: String?) {
        scope.launch {
            try {
                api.selectProfile(p.uuid, code)
                onSelected()
            } catch (e: ApiException) {
                message = when (e.error) {
                    "pin_required" -> { askPin = p; null }
                    "wrong_pin" -> "Wrong PIN for ${p.title}."
                    else -> "Couldn't switch to ${p.title} (${e.message})."
                }
                pin = ""
            } catch (e: Exception) {
                message = "Couldn't switch to ${p.title} (${e.message ?: e.javaClass.simpleName})."
            }
        }
    }

    Centered {
        Text("Who's watching?", style = MaterialTheme.typography.headlineLarge, color = Accent)
        val asking = askPin
        if (asking != null) {
            Text("PIN for ${asking.title}", style = MaterialTheme.typography.titleMedium)
            Row(horizontalArrangement = Arrangement.spacedBy(16.dp), verticalAlignment = Alignment.CenterVertically) {
                TvTextField(pin, { if (it.length <= 4 && it.all(Char::isDigit)) pin = it }, "••••", KeyboardType.NumberPassword,
                    autoFocus = true, secret = true, onDone = { select(asking, pin) })
                Button(onClick = { select(asking, pin) }, enabled = pin.length == 4) { Text("OK") }
                OutlinedButton(onClick = { askPin = null; pin = "" }) { Text("Cancel") }
            }
        } else {
            Row(horizontalArrangement = Arrangement.spacedBy(32.dp)) {
                profiles?.forEachIndexed { i, p ->
                    Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(12.dp)) {
                        androidx.tv.material3.Surface(
                            onClick = { if (p.isProtected) askPin = p else select(p, null) },
                            shape = androidx.tv.material3.ClickableSurfaceDefaults.shape(CircleShape),
                            modifier = Modifier.size(96.dp).then(if (i == 0) Modifier.focusRequester(first) else Modifier),
                        ) {
                            if (p.thumb != null) {
                                AsyncImage(model = p.thumb, contentDescription = p.title, modifier = Modifier.fillMaxSize())
                            } else {
                                Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                                    Text(p.title.take(1).uppercase(), fontSize = 40.sp)
                                }
                            }
                        }
                        Text(p.title + if (p.isProtected) " 🔒" else "", style = MaterialTheme.typography.titleMedium)
                    }
                }
            }
        }
        message?.let { Text(it, style = MaterialTheme.typography.bodyLarge) }
    }
}
