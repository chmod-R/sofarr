package io.github.chmodr.sofarr

import android.os.Bundle
import android.view.KeyEvent as AndroidKeyEvent
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
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
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.nativeKeyCode
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import androidx.tv.material3.LocalContentColor
import androidx.tv.material3.LocalTextStyle
import androidx.tv.material3.MaterialTheme
import androidx.tv.material3.Text
import androidx.tv.material3.darkColorScheme
import coil3.ImageLoader
import coil3.compose.AsyncImage
import coil3.compose.setSingletonImageLoaderFactory
import coil3.network.okhttp.OkHttpNetworkFetcherFactory
import coil3.request.crossfade
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import okhttp3.HttpUrl

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
        setContent { SofarrTheme { App() } }
    }
}

@Composable
fun SofarrTheme(content: @Composable () -> Unit) {
    setSingletonImageLoaderFactory { ctx ->
        ImageLoader.Builder(ctx)
            .components { add(OkHttpNetworkFetcherFactory(callFactory = { Sofarr.client(ctx) })) }
            .crossfade(300) // images fade in when loaded, as on the web
            .build()
    }
    MaterialTheme(colorScheme = darkColorScheme(primary = Tokens.Accent, background = Tokens.Bg)) {
        // Text outside a tv-material Surface takes LocalContentColor, which defaults to black.
        // Line height relative to the text (the web's 1.4), not the TV toolkit's fixed one for large type.
        CompositionLocalProvider(
            LocalContentColor provides Tokens.Text,
            LocalTextStyle provides LocalTextStyle.current.merge(TextStyle(lineHeight = 1.4.em)),
        ) {
            Box(Modifier.fillMaxSize().background(Tokens.Bg)) { content() }
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
        Screen.Loading -> Centered { Brand(large = true) }
        Screen.SignIn -> SignIn(api!!, onSignedIn = { route() })
        Screen.Profiles -> ProfilePicker(api!!, onSelected = { screen = Screen.Home })
        Screen.Home -> HomeScreen(
            api!!,
            onSwitchProfile = {
                scope.launch {
                    runCatching { api!!.deselectProfile() }
                    screen = Screen.Profiles
                }
            },
            onSignOut = {
                scope.launch {
                    runCatching { api!!.signOut() }
                    Sofarr.cookieJar(context).clear()
                    screen = Screen.SignIn
                }
            },
        )
        is Screen.Problem -> Centered {
            val focus = remember { FocusRequester() }
            LaunchedEffect(Unit) { focus.requestFocus() }
            Text(s.message, color = Tokens.Text, fontSize = 11.sp)
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                SofarrButton("Try again", { route() }, kind = ButtonKind.Primary, modifier = Modifier.focusRequester(focus))
                SofarrButton("Change server", { screen = Screen.Setup })
            }
        }
    }
}

/** `.center-screen` */
@Composable
fun Centered(content: @Composable () -> Unit) {
    Box(Modifier.fillMaxSize().padding(Tokens.Gutter), contentAlignment = Alignment.Center) {
        Column(verticalArrangement = Arrangement.spacedBy(12.5.dp), horizontalAlignment = Alignment.CenterHorizontally) {
            content()
        }
    }
}

/** `.brand` / `.brand-large` */
@Composable
fun Brand(large: Boolean = false) = Text(
    "Sofarr",
    color = Tokens.Accent,
    fontSize = if (large) 30.sp else 16.sp,
    fontWeight = FontWeight.ExtraBold,
    letterSpacing = 0.02.em,
    modifier = if (large) Modifier.padding(bottom = 8.dp) else Modifier,
)

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
        Brand(large = true)
        Text("Enter your Sofarr server's address.", color = Tokens.Text, fontSize = 13.sp)
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
            TvTextField(text, { text = it }, "192.168.1.10:5656", KeyboardType.Uri, autoFocus = true, onDone = { connect() })
            SofarrButton("Connect", { connect() }, kind = ButtonKind.Primary, enabled = !checking)
        }
        message?.let { Text(it, color = Tokens.Muted, fontSize = 10.sp) }
    }
}

/** `.search-input` style text field. */
@Composable
fun TvTextField(
    value: String,
    onValueChange: (String) -> Unit,
    placeholder: String,
    keyboardType: KeyboardType,
    autoFocus: Boolean = false,
    onDone: () -> Unit,
) {
    var focused by remember { mutableStateOf(false) }
    val focus = remember { FocusRequester() }
    if (autoFocus) LaunchedEffect(Unit) { focus.requestFocus() }
    BasicTextField(
        value = value,
        onValueChange = onValueChange,
        singleLine = true,
        textStyle = TextStyle(color = Tokens.Text, fontSize = 13.sp),
        cursorBrush = SolidColor(Tokens.Accent),
        keyboardOptions = KeyboardOptions(keyboardType = keyboardType, imeAction = ImeAction.Go),
        keyboardActions = KeyboardActions(onGo = { onDone() }),
        modifier = Modifier
            .width(300.dp)
            .focusRequester(focus)
            .onFocusChanged { focused = it.isFocused }
            .clip(RoundedCornerShape(Tokens.Radius))
            .background(Tokens.BgRaised)
            .border(BorderStroke(2.dp, if (focused) Tokens.Accent else Color.White.copy(alpha = 0.15f)), RoundedCornerShape(Tokens.Radius))
            .padding(horizontal = 10.dp, vertical = 7.5.dp),
        decorationBox = { inner ->
            if (value.isEmpty()) Text(placeholder, color = Tokens.Muted, fontSize = 13.sp)
            inner()
        },
    )
}

/** Plex sign-in (the web's SignIn): a code for plex.tv/link, and wait until it's linked. */
@Composable
private fun SignIn(api: SofarrApi, onSignedIn: () -> Unit) {
    var pin by remember { mutableStateOf<Pin?>(null) }
    var problem by remember { mutableStateOf<String?>(null) }
    var attempt by remember { mutableStateOf(0) }
    val focus = remember { FocusRequester() }

    LaunchedEffect(attempt) {
        pin = null
        problem = null
        try {
            pin = api.startPin()
            while (true) {
                delay(2_000)
                val s = api.pollPin()
                when (s.status) {
                    "waiting" -> Unit
                    "signed_in" -> { onSignedIn(); return@LaunchedEffect }
                    "expired", "no_pending_login" -> { problem = "That code expired."; break }
                    "denied" -> { problem = s.reason ?: "This Plex account can't sign in here."; break }
                    else -> { problem = "Sign-in failed (${s.status})."; break }
                }
            }
        } catch (e: Exception) {
            problem = "Couldn't start sign-in (${e.message ?: e.javaClass.simpleName})."
        }
        delay(50)
        runCatching { focus.requestFocus() }
    }

    Centered {
        Brand(large = true)
        val p = pin
        when {
            problem != null -> {
                Text(problem!!, color = Tokens.Text, fontSize = 11.sp)
                SofarrButton("Get a new code", { attempt++ }, kind = ButtonKind.Primary, modifier = Modifier.focusRequester(focus))
            }
            p == null -> Text("Getting a sign-in code…", color = Tokens.Muted, fontSize = 10.sp)
            else -> Row(horizontalArrangement = Arrangement.spacedBy(30.dp), verticalAlignment = Alignment.CenterVertically) {
                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    Text(
                        buildAnnotatedString {
                            append("On your phone or computer, go to ")
                            pushStyle(SpanStyle(fontWeight = FontWeight.Bold)); append("plex.tv/link"); pop()
                        },
                        color = Tokens.Text, fontSize = 13.sp,
                    )
                    Text("and enter this code:", color = Tokens.Text, fontSize = 13.sp)
                    // .signin-code: big, amber, widely spaced
                    Text(p.code, color = Tokens.Accent, fontSize = 45.sp, fontWeight = FontWeight.ExtraBold, letterSpacing = 0.35.em,
                        modifier = Modifier.padding(start = 15.dp, top = 10.dp, bottom = 10.dp))
                    Text("This screen continues by itself once you've entered it.", color = Tokens.Muted, fontSize = 8.5.sp)
                }
                p.qrUrl?.let {
                    Column(horizontalAlignment = Alignment.CenterHorizontally) {
                        // Plex's QR is white on transparent (made for dark screens): drawn black on white,
                        // which every phone camera reads.
                        AsyncImage(
                            model = it,
                            contentDescription = "QR code that opens plex.tv/link with this code",
                            colorFilter = ColorFilter.tint(Color.Black),
                            modifier = Modifier.size(120.dp).clip(RoundedCornerShape(Tokens.Radius)).background(Color.White).padding(6.dp),
                        )
                        Spacer(Modifier.height(5.dp))
                        Text("Or scan with your phone", color = Tokens.Muted, fontSize = 8.5.sp)
                    }
                }
            }
        }
    }
}

/** Plex Home users (the web's ProfilePicker); protected ones ask for their PIN on a pad. */
@Composable
private fun ProfilePicker(api: SofarrApi, onSelected: () -> Unit) {
    var profiles by remember { mutableStateOf<List<Profile>?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var asking by remember { mutableStateOf<Profile?>(null) }
    val first = remember { FocusRequester() }
    val scope = rememberCoroutineScope()

    LaunchedEffect(Unit) {
        try {
            profiles = api.profiles()
        } catch (e: Exception) {
            error = "Couldn't load profiles from Plex."
        }
    }
    LaunchedEffect(profiles, asking) {
        if (profiles != null && asking == null) {
            delay(50)
            runCatching { first.requestFocus() }
        }
    }

    /** null when it worked; otherwise what to tell the person. */
    suspend fun choose(p: Profile, pin: String?): String? = try {
        api.selectProfile(p.uuid, pin)
        onSelected()
        null
    } catch (e: ApiException) {
        when (e.error) {
            "wrong_pin" -> "Wrong PIN"
            "pin_required" -> { asking = p; null }
            else -> "Couldn't switch profile"
        }
    } catch (e: Exception) {
        "Couldn't switch profile"
    }

    val a = asking
    if (a != null) {
        Centered { PinPad(api, a, onDone = { choose(a, it) }, onCancel = { asking = null }) }
        return
    }
    Centered {
        Text("Who's watching?", color = Tokens.Text, fontSize = 24.sp, fontWeight = FontWeight.Bold)
        error?.let { Text(it, color = Tokens.Error, fontSize = 10.sp) }
        if (profiles == null && error == null) Text("Loading…", color = Tokens.Muted, fontSize = 10.sp)
        Row(horizontalArrangement = Arrangement.spacedBy(20.dp), modifier = Modifier.padding(top = 10.dp, bottom = 20.dp)) {
            profiles?.forEachIndexed { i, p ->
                FocusBox(
                    onClick = { if (p.isProtected) asking = p else scope.launch { choose(p, null)?.let { error = it } } },
                    modifier = if (i == 0) Modifier.focusRequester(first) else Modifier,
                    focusedScale = 1.08f,
                    ring = false,
                ) { focused ->
                    Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(7.5.dp),
                        modifier = Modifier.padding(8.dp)) {
                        Box(Modifier.focusRing(focused, 6.dp)) { Avatar(api, p, 80.dp) }
                        Text(p.title, color = if (focused) Tokens.Text else Tokens.Muted, fontSize = 12.sp)
                    }
                }
            }
        }
    }
}

private val PIN_KEYS = listOf("1", "2", "3", "4", "5", "6", "7", "8", "9", "⌫", "0", "OK")

/** The web's PinPad: four dots and a keypad, plus the remote's number keys. */
@Composable
private fun PinPad(api: SofarrApi, profile: Profile, onDone: suspend (String) -> String?, onCancel: () -> Unit) {
    var pin by remember { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val first = remember { FocusRequester() }
    LaunchedEffect(Unit) {
        delay(50)
        runCatching { first.requestFocus() }
    }

    fun submit(value: String) {
        if (value.length != 4 || busy) return
        busy = true
        scope.launch {
            val err = onDone(value)
            busy = false
            if (err != null) {
                error = err
                pin = ""
            }
        }
    }

    fun press(k: String) {
        error = null
        when (k) {
            "⌫" -> pin = pin.dropLast(1)
            "OK" -> submit(pin)
            else -> if (pin.length < 4) {
                pin += k
                if (pin.length == 4) submit(pin)
            }
        }
    }

    BackHandler { if (pin.isNotEmpty()) pin = pin.dropLast(1) else onCancel() }

    Column(
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(7.5.dp),
        modifier = Modifier.onPreviewKeyEvent { e ->
            val code = e.key.nativeKeyCode
            if (e.type == KeyEventType.KeyDown && code in AndroidKeyEvent.KEYCODE_0..AndroidKeyEvent.KEYCODE_9) {
                press("${code - AndroidKeyEvent.KEYCODE_0}")
                true
            } else {
                false
            }
        },
    ) {
        Avatar(api, profile, 80.dp)
        Text(profile.title, color = Tokens.Text, fontSize = 15.sp, fontWeight = FontWeight.Bold)
        Text("Enter PIN", color = Tokens.Muted, fontSize = 10.sp)
        Row(horizontalArrangement = Arrangement.spacedBy(9.dp), modifier = Modifier.padding(vertical = 5.dp)) {
            repeat(4) { i ->
                val on = i < pin.length
                Box(Modifier.size(10.dp).clip(CircleShape).background(if (on) Tokens.Text else Color.Transparent)
                    .border(2.dp, if (on) Tokens.Text else Tokens.Muted, CircleShape))
            }
        }
        error?.let { Text(it, color = Tokens.Error, fontSize = 10.sp) }
        Column(verticalArrangement = Arrangement.spacedBy(7.5.dp)) {
            PIN_KEYS.chunked(3).forEachIndexed { r, keys ->
                Row(horizontalArrangement = Arrangement.spacedBy(7.5.dp)) {
                    keys.forEachIndexed { c, k ->
                        FocusBox({ press(k) }, modifier = if (r == 0 && c == 0) Modifier.focusRequester(first) else Modifier) { focused ->
                            Box(
                                Modifier.width(45.dp).height(35.dp).background(if (focused) Tokens.Text else Color.White.copy(alpha = 0.12f)),
                                contentAlignment = Alignment.Center,
                            ) {
                                Text(k, color = if (focused) Tokens.Bg else Tokens.Text, fontSize = 14.sp, fontWeight = FontWeight.SemiBold)
                            }
                        }
                    }
                }
            }
        }
    }
}
