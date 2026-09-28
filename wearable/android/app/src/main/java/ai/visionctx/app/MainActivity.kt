package ai.visionctx.app

import android.Manifest
import android.app.Activity
import android.content.pm.PackageManager
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.os.Bundle
import android.text.InputType
import android.view.Gravity
import android.view.View
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.view.ViewGroup.LayoutParams.WRAP_CONTENT
import android.widget.ArrayAdapter
import android.widget.Button
import android.widget.CheckBox
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.Spinner
import android.widget.TextView
import android.widget.Toast
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch

/** Setup + status screen. The voice loop itself runs in [AssistantService]. */
class MainActivity : Activity() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private val prefs by lazy { getSharedPreferences("visionctx", MODE_PRIVATE) }
    private var devices: List<Device> = emptyList()

    private lateinit var serverInput: EditText
    private lateinit var deviceSpinner: Spinner
    private lateinit var keepRoute: CheckBox
    private lateinit var startButton: Button
    private lateinit var status: TextView
    private lateinit var askButton: Button
    private lateinit var retryButton: Button
    private lateinit var taskInput: EditText
    private lateinit var textInput: EditText
    private lateinit var log: TextView

    private val dp get() = resources.displayMetrics.density

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(buildUi())
        requestPermissionsIfNeeded()
        scope.launch { Assistant.ui.collect { render(it) } }
        if (serverInput.text.isNotEmpty()) loadDevices()
    }

    override fun onDestroy() {
        scope.cancel()
        super.onDestroy()
    }

    // --- UI -----------------------------------------------------------------------------------------

    private fun buildUi(): View {
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            val pad = (16 * dp).toInt()
            setPadding(pad, pad, pad, pad)
        }
        fun label(text: String) = TextView(this).apply {
            this.text = text
            setTypeface(typeface, Typeface.BOLD)
            setPadding(0, (14 * dp).toInt(), 0, (4 * dp).toInt())
        }
        fun row(vararg views: View) = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            views.forEach { addView(it) }
        }
        fun weighted(v: View) = v.apply { layoutParams = LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f) }

        root.addView(TextView(this).apply {
            text = "VisionCtx 视觉助手"
            textSize = 22f
            setTypeface(typeface, Typeface.BOLD)
        })

        root.addView(label("服务器"))
        serverInput = EditText(this).apply {
            hint = "http://192.168.1.10:8000"
            inputType = InputType.TYPE_TEXT_VARIATION_URI
            setSingleLine()
            setText(prefs.getString("server", ""))
        }
        root.addView(row(weighted(serverInput),
            Button(this).apply { text = "自动发现"; setOnClickListener { discover() } }))

        root.addView(label("摄像头模组"))
        deviceSpinner = Spinner(this)
        root.addView(row(weighted(deviceSpinner),
            Button(this).apply { text = "刷新"; setOnClickListener { loadDevices() } }))

        keepRoute = CheckBox(this).apply {
            text = "耳机麦克风常开（延迟更低，耳机处于通话模式）"
            isChecked = prefs.getBoolean("keep_route", true)
        }
        root.addView(keepRoute)

        startButton = Button(this).apply { setOnClickListener { toggleService() } }
        root.addView(startButton)

        status = TextView(this).apply { setPadding(0, (8 * dp).toInt(), 0, (8 * dp).toInt()) }
        root.addView(status)

        askButton = Button(this).apply {
            textSize = 20f
            minHeight = (96 * dp).toInt()
            setOnClickListener { AssistantService.send(this@MainActivity, AssistantService.ACTION_TRIGGER) }
        }
        root.addView(askButton, LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT))
        retryButton = Button(this).apply {
            text = "重问（上一个回答不对）"
            setOnClickListener { AssistantService.send(this@MainActivity, AssistantService.ACTION_RETRY) }
        }
        root.addView(retryButton)
        root.addView(TextView(this).apply {
            text = "耳机：单击 = 开始/结束提问（说完停顿会自动结束），下一曲 = 重问"
            textSize = 12f
            alpha = 0.7f
        })

        root.addView(label("当前任务"))
        taskInput = EditText(this).apply { hint = "例如：装路由器（也可以直接说“我现在要装路由器”）"; setSingleLine() }
        root.addView(row(weighted(taskInput),
            Button(this).apply {
                text = "设置"
                setOnClickListener {
                    AssistantService.send(this@MainActivity, AssistantService.ACTION_SET_TASK) {
                        putExtra(AssistantService.EXTRA_TEXT, taskInput.text.toString())
                    }
                }
            }))
        root.addView(Button(this).apply {
            text = "新对话（清空任务和上下文）"
            setOnClickListener { AssistantService.send(this@MainActivity, AssistantService.ACTION_NEW_CONVERSATION) }
        })

        root.addView(label("键入提问（调试用）"))
        textInput = EditText(this).apply { hint = "这个是什么？"; setSingleLine() }
        root.addView(row(weighted(textInput),
            Button(this).apply {
                text = "发送"
                setOnClickListener {
                    AssistantService.send(this@MainActivity, AssistantService.ACTION_ASK_TEXT) {
                        putExtra(AssistantService.EXTRA_TEXT, textInput.text.toString())
                    }
                    textInput.setText("")
                }
            }))

        root.addView(label("对话"))
        log = TextView(this).apply { setTextIsSelectable(true) }
        root.addView(log)

        return ScrollView(this).apply { addView(root) }
    }

    private fun render(s: UiState) {
        val running = s.phase != Phase.STOPPED
        startButton.text = if (running) "停止助手" else "启动助手"
        serverInput.isEnabled = !running
        deviceSpinner.isEnabled = !running
        keepRoute.isEnabled = !running
        askButton.isEnabled = running && s.phase != Phase.THINKING
        retryButton.isEnabled = running && s.turns.isNotEmpty() && s.phase in setOf(Phase.IDLE, Phase.SPEAKING)

        val (label, color) = when (s.phase) {
            Phase.STOPPED -> "未启动" to Color.GRAY
            Phase.IDLE -> "点击提问" to Color.parseColor("#2563EB")
            Phase.LISTENING -> "在听…点击结束" to Color.parseColor("#DC2626")
            Phase.THINKING -> "思考中…" to Color.parseColor("#B45309")
            Phase.SPEAKING -> "回答中…点击打断并提问" to Color.parseColor("#15803D")
        }
        askButton.text = label
        askButton.setTextColor(Color.WHITE)
        askButton.background = GradientDrawable().apply { cornerRadius = 16 * dp; setColor(color) }

        val session = s.session?.let { "实验第 ${it.id} 轮 · ${it.participant} · ${it.mount} · ${it.task}" } ?: "未在实验轮次中"
        status.text = listOfNotNull(
            if (running) (if (s.bluetooth) "🎧 蓝牙耳机已连接" else "📱 使用手机麦克风/扬声器") else null,
            session,
            s.message.ifEmpty { null },
        ).joinToString("\n")
        if (!taskInput.hasFocus() && taskInput.text.toString() != s.taskText) taskInput.setText(s.taskText)

        log.text = s.turns.joinToString("\n\n") { t ->
            val head = listOfNotNull(t.intent?.let { "[$it]" }, if (t.retryOf != null) "[重问]" else null).joinToString(" ")
            "$head 你：${t.transcript ?: "…"}\n助手：${t.answer ?: t.error ?: "…"}"
        }
    }

    // --- actions ----------------------------------------------------------------------------------------

    private fun server() = serverInput.text.toString().trim().trimEnd('/')

    private fun discover() {
        scope.launch {
            Toast.makeText(this@MainActivity, "正在查找服务器…", Toast.LENGTH_SHORT).show()
            val url = Discovery.find(this@MainActivity)
            if (url == null) {
                Toast.makeText(this@MainActivity, "没找到，请手动填写", Toast.LENGTH_LONG).show()
            } else {
                serverInput.setText(url)
                loadDevices()
            }
        }
    }

    private fun loadDevices() {
        val server = server()
        if (server.isEmpty()) return
        scope.launch {
            try {
                devices = Api(server).devices()
                prefs.edit().putString("server", server).apply()
                deviceSpinner.adapter = ArrayAdapter(
                    this@MainActivity, android.R.layout.simple_spinner_dropdown_item,
                    devices.map { "${it.name}${if (it.online) "" else "（离线）"}" },
                )
                val saved = devices.indexOfFirst { it.id == prefs.getString("device", null) }
                if (saved >= 0) deviceSpinner.setSelection(saved)
                if (devices.isEmpty()) toast("服务器上还没有摄像头模组")
            } catch (e: Exception) {
                toast("连不上服务器：${e.message}")
            }
        }
    }

    private fun toggleService() {
        if (Assistant.ui.value.phase != Phase.STOPPED) {
            AssistantService.send(this, AssistantService.ACTION_STOP)
            return
        }
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            requestPermissionsIfNeeded()
            return
        }
        val device = devices.getOrNull(deviceSpinner.selectedItemPosition)
        if (server().isEmpty() || device == null) {
            toast("先填服务器并选择摄像头模组")
            return
        }
        prefs.edit().putString("device", device.id).putBoolean("keep_route", keepRoute.isChecked).apply()
        AssistantService.send(this, AssistantService.ACTION_START) {
            putExtra(AssistantService.EXTRA_SERVER, server())
            putExtra(AssistantService.EXTRA_DEVICE, device.id)
            putExtra(AssistantService.EXTRA_KEEP_ROUTE, keepRoute.isChecked)
        }
    }

    private fun requestPermissionsIfNeeded() {
        val wanted = buildList {
            add(Manifest.permission.RECORD_AUDIO)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) add(Manifest.permission.BLUETOOTH_CONNECT)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) add(Manifest.permission.POST_NOTIFICATIONS)
        }.filter { checkSelfPermission(it) != PackageManager.PERMISSION_GRANTED }
        if (wanted.isNotEmpty()) requestPermissions(wanted.toTypedArray(), 1)
    }

    private fun toast(msg: String) = Toast.makeText(this, msg, Toast.LENGTH_LONG).show()
}
