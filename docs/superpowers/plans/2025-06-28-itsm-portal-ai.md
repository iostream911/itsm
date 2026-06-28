# ITSM 门户首页 + AI 智能客服 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增门户首页 home.html，集成 AI 智能客服（FAQ 问答 + 自动提单），登录后跳转到首页。

**Architecture:** 新增 POST /api/ai/chat 端点调用 DeepSeek API，前端 home.html 对话式 UI，AI 返回 JSON 区分 FAQ/工单两种模式。

**Tech Stack:** Node.js/Express, H5 前端, DeepSeek API, 现有 JWT 认证

## Global Constraints

- AI 客服只做 FAQ + 工单两种模式，不做多轮对话上下文
- 自助改密仅占位入口
- 对话历史存 localStorage，服务端不保存
- DeepSeek key 存在服务端，前端不可见

---

## File Structure

| 文件 | 操作 | 职责 |
|------|------|------|
| `.env` | Modify | 新增 DEEPSEEK_API_KEY |
| `server.js` | Modify | 新增 POST /api/ai/chat（行86后插入） |
| `h5/home.html` | Create | 门户首页，AI 对话 + 快捷入口 + 底部导航 |
| `h5/login.html` | Modify | 登录后跳转 home.html |

---

### Task 1: 配置 DeepSeek API Key

**Files:**
- Modify: `.env:1`

- [ ] **Step 1: 在 .env 新增 DeepSeek key**

`.env` 第一行后插入：
```
DEEPSEEK_API_KEY=<你的DeepSeek API Key>
```

- [ ] **Step 2: 验证 key 可用**

```bash
curl -s https://api.deepseek.com/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <你的DeepSeek API Key>" \
  -d '{"model":"deepseek-chat","messages":[{"role":"user","content":"你好"}],"max_tokens":50}' | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['choices'][0]['message']['content'][:50])"
```

- [ ] **Step 3: Commit**

```bash
git add .env
git commit -m "feat: add DeepSeek API key for AI chat"
```

---

### Task 2: 后端 POST /api/ai/chat

**Files:**
- Modify: `server.js` — 在 `authMiddleware` 定义之后（约 line 96）插入新路由

**Interfaces:**
- Consumes: `authMiddleware` (line 86), `API_TOKEN` (line 45)
- Produces: `POST /api/ai/chat` — 接收 `{message}` 返回 `{type, content}` 或 `{type, title, group, description}`

- [ ] **Step 1: 在 server.js 中插入 AI chat 路由**

约在 line 96（`authMiddleware` 之后，第一个路由之前）插入：

```javascript
// ── AI 智能客服 ──
const DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY || '';

const AI_SYSTEM_PROMPT = `你是苏州名城集团 IT 服务中心的智能客服助手。请用正式、专业的语气回答用户问题。

你可以处理以下三种情况的用户请求：

1. FAQ（简单咨询）：用户询问IT相关问题，你可以直接给出答案。
2. 创建工单（需要人工处理）：用户描述了一个需要IT人员处理的问题。

回复格式必须是严格的 JSON：
- FAQ: {"type":"faq","content":"你的回答（简洁、分步骤）"}
- 工单: {"type":"ticket","title":"工单标题（简短）","group":"分组名","description":"问题描述"}

三个运维分组及其职责：
- 桌面运维：电脑、打印机、会议设备、鼠标键盘、软件安装
- 网络运维：网络连接、VPN、端口、WiFi
- 应用系统运维：ERP、OA、邮箱、账号权限、系统登录

示例：
用户："电脑无法开机怎么办"
你：{"type":"faq","content":"建议按以下步骤排查：1. 检查电源线是否连接正常 2. 长按电源键10秒后重新开机 3. 如仍无法开机，请提交工单处理"}

用户："帮我重置邮箱密码"
你：{"type":"ticket","title":"邮箱密码重置","group":"应用系统运维","description":"用户请求重置邮箱密码，需要管理员协助处理。"}`;

app.post('/api/ai/chat', authMiddleware, async (req, res) => {
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: '请输入问题' });
  try {
    const aiRes = await fetch('https://api.deepseek.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${DEEPSEEK_KEY}` },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [
          { role: 'system', content: AI_SYSTEM_PROMPT },
          { role: 'user', content: message }
        ],
        max_tokens: 500,
        temperature: 0.3
      })
    });
    const aiData = await aiRes.json();
    const reply = aiData.choices?.[0]?.message?.content || '';
    const data = JSON.parse(reply);
    res.json(data);
  } catch (e) {
    res.json({ type: 'faq', content: '抱歉，AI 服务暂时不可用，请稍后重试或直接提交工单。' });
  }
});
```

- [ ] **Step 2: 测试 API**

```bash
curl -sk -X POST "https://172.24.16.40:3001/api/ai/chat" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $(curl -sk -X POST 'https://172.24.16.40:3001/auth/login' -H 'Content-Type: application/json' -d '{"phone":"18629618884","code":"000000"}' 2>/dev/null | python3 -c "import sys,json;print(json.load(sys.stdin).get('token',''))" 2>/dev/null)" \
  -d '{"message":"电脑无法开机"}' 2>/dev/null | python3 -m json.tool
```

> 注意：需要先获取有效验证码才能拿到 Token 测试。部署后直接用浏览器测试更方便。

- [ ] **Step 3: Commit**

```bash
git add server.js
git commit -m "feat: add POST /api/ai/chat endpoint with DeepSeek integration"
```

---

### Task 3: 门户首页 home.html

**Files:**
- Create: `h5/home.html`

**Interfaces:**
- Consumes: `POST /api/ai/chat` (Task 2), `GET /api/v1/users-stats` (已有), `localStorage` token/role
- Produces: AI 对话 UI, 快捷入口, 按角色底部导航

- [ ] **Step 1: 创建 home.html**

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover">
  <title>IT 服务中心</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', sans-serif; background: #f3f4f6; min-height: 100vh; padding-bottom: 80px; }
    .header { background: #1e40af; color: #fff; padding: 14px 20px; font-size: 17px; font-weight: 600; text-align: center; position: sticky; top: 0; z-index: 10; display: flex; align-items: center; justify-content: center; }
    .header .logout-btn { position: absolute; right: 12px; top: 50%; transform: translateY(-50%); background: rgba(255,255,255,0.15); border: none; color: #fff; padding: 6px 12px; border-radius: 6px; font-size: 12px; cursor: pointer; }
    .container { max-width: 600px; margin: 0 auto; padding: 16px; }
    .welcome { font-size: 15px; color: #374151; margin-bottom: 16px; text-align: center; }
    .welcome span { font-weight: 600; color: #1e40af; }

    .chat-card { background: #fff; border-radius: 12px; box-shadow: 0 1px 3px rgba(0,0,0,0.06); margin-bottom: 16px; overflow: hidden; }
    .chat-header { background: #eff6ff; padding: 12px 16px; font-size: 15px; font-weight: 600; color: #1e40af; border-bottom: 1px solid #dbeafe; }
    .chat-body { padding: 12px; max-height: 400px; overflow-y: auto; min-height: 80px; }
    .chat-msg { margin-bottom: 12px; display: flex; gap: 8px; }
    .chat-msg.user { flex-direction: row-reverse; }
    .chat-bubble { max-width: 85%; padding: 10px 14px; border-radius: 12px; font-size: 14px; line-height: 1.5; white-space: pre-wrap; }
    .chat-msg.assistant .chat-bubble { background: #f0f9ff; border: 1px solid #bae6fd; color: #0c4a6e; }
    .chat-msg.user .chat-bubble { background: #2563eb; color: #fff; }
    .chat-msg .avatar { width: 32px; height: 32px; border-radius: 16px; display: flex; align-items: center; justify-content: center; font-size: 16px; flex-shrink: 0; }
    .chat-msg.assistant .avatar { background: #dbeafe; }

    .ticket-confirm { background: #fffbeb; border: 1px solid #fcd34d; border-radius: 8px; padding: 12px; margin: 8px 0; }
    .ticket-confirm input, .ticket-confirm select, .ticket-confirm textarea { width: 100%; padding: 8px; border: 1px solid #d1d5db; border-radius: 6px; font-size: 13px; margin-bottom: 6px; background: #fff; }
    .ticket-confirm button { padding: 8px 16px; border-radius: 6px; font-size: 13px; cursor: pointer; border: none; }
    .btn-create { background: #2563eb; color: #fff; margin-right: 8px; }
    .btn-cancel { background: #f3f4f6; color: #374151; }

    .chat-input { display: flex; gap: 8px; padding: 12px; border-top: 1px solid #e5e7eb; }
    .chat-input input { flex: 1; padding: 10px 14px; border: 1px solid #d1d5db; border-radius: 20px; font-size: 14px; outline: none; background: #f9fafb; }
    .chat-input input:focus { border-color: #2563eb; }
    .chat-input button { padding: 10px 18px; background: #2563eb; color: #fff; border: none; border-radius: 20px; font-size: 14px; cursor: pointer; white-space: nowrap; }

    .shortcuts { display: flex; gap: 8px; margin-bottom: 16px; }
    .shortcut { flex: 1; background: #fff; border-radius: 10px; padding: 14px; text-align: center; box-shadow: 0 1px 3px rgba(0,0,0,0.06); cursor: pointer; text-decoration: none; color: #111827; transition: all 0.15s; }
    .shortcut:active { transform: scale(0.97); }
    .shortcut-icon { font-size: 22px; margin-bottom: 4px; }
    .shortcut-label { font-size: 12px; font-weight: 500; }
    .shortcut-badge { font-size: 10px; color: #9ca3af; margin-top: 2px; }

    .bottom-bar { position: fixed; bottom: 0; left: 0; right: 0; background: rgba(255,255,255,0.95); backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px); border-top: 1px solid #e5e7eb; display: flex; z-index: 50; padding: 4px 0 env(safe-area-inset-bottom, 6px); overflow-x: auto; }
    .nav-item { flex: 1; min-width: 48px; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 4px 2px; color: #9ca3af; text-decoration: none; font-size: 9px; cursor: pointer; border: none; background: none; }
    .nav-item .icon { font-size: 18px; line-height: 1; margin-bottom: 1px; }
    .nav-item.active { color: #2563eb; }
    .typing { display: flex; gap: 4px; padding: 10px 14px; }
    .typing span { width: 6px; height: 6px; background: #93c5fd; border-radius: 50%; animation: bounce 1.2s infinite; }
    .typing span:nth-child(2) { animation-delay: 0.2s; } .typing span:nth-child(3) { animation-delay: 0.4s; }
    @keyframes bounce { 0%,60%,100% { transform: translateY(0); } 30% { transform: translateY(-4px); } }
  </style>
</head>
<body>
  <div class="header">IT 服务中心<button class="logout-btn" onclick="logout()">退出登录</button></div>
  <div class="container">
    <div class="welcome" id="welcomeText">加载中...</div>

    <div class="shortcuts">
      <a class="shortcut" href="list.html">
        <div class="shortcut-icon">📋</div><div class="shortcut-label">我的工单</div><div class="shortcut-badge" id="ticketCount">-</div>
      </a>
      <a class="shortcut" href="submit.html">
        <div class="shortcut-icon">🔧</div><div class="shortcut-label">快速提单</div>
      </a>
      <div class="shortcut" onclick="showPwdComing()">
        <div class="shortcut-icon">🔑</div><div class="shortcut-label">自助改密</div><div class="shortcut-badge">敬请期待</div>
      </div>
    </div>

    <div class="chat-card">
      <div class="chat-header">💬 AI 智能客服</div>
      <div class="chat-body" id="chatBody">
        <div class="chat-msg assistant">
          <div class="avatar">🤖</div>
          <div class="chat-bubble">您好！我是IT服务助手，可以帮您解答问题或创建工单。请描述您遇到的问题。</div>
        </div>
      </div>
      <div class="chat-input">
        <input type="text" id="chatInput" placeholder="描述您遇到的问题..." onkeydown="if(event.key==='Enter')sendMessage()">
        <button onclick="sendMessage()">发送</button>
      </div>
    </div>
  </div>

  <nav class="bottom-bar" id="bottomNav"></nav>

  <script>
    const PAGE = 'home';
    function getToken() { return localStorage.getItem('it_token'); }
    function getRole()  { return localStorage.getItem('it_role') || 'customer'; }
    function logout()   { localStorage.clear(); location.href='login.html'; }

    function buildNav(role) {
      const items = [
        { id:'home', icon:'🏠', label:'首页', href:'home.html', roles:['admin','agent','customer'] },
        { id:'list', icon:'📋', label:'工单', href:'list.html', roles:['admin','agent','customer'] },
        { id:'submit', icon:'✍️', label:'提单', href:'submit.html', roles:['admin','agent','customer'] },
        { id:'agent', icon:'📊', label:'看板', href:'agent.html', roles:['admin','agent'] },
        { id:'admin', icon:'🖥️', label:'管理', href:'admin.html', roles:['admin'] },
        { id:'users', icon:'👥', label:'用户', href:'users.html', roles:['admin'] }
      ];
      return items.filter(i => i.roles.includes(role)).map(i =>
        `<a class="nav-item${PAGE===i.id?' active':''}" href="${i.href}"><span class="icon">${i.icon}</span>${i.label}</a>`
      ).join('');
    }

    function showPwdComing() { alert('自助改密功能即将上线。如需修改密码，请联系IT部门。'); }

    async function sendMessage() {
      const input = document.getElementById('chatInput');
      const msg = input.value.trim();
      if (!msg) return;
      input.value = '';

      const body = document.getElementById('chatBody');
      body.innerHTML += `<div class="chat-msg user"><div class="chat-bubble">${msg}</div></div>`;
      body.innerHTML += '<div class="chat-msg assistant"><div class="avatar">🤖</div><div class="typing"><span></span><span></span><span></span></div></div>';
      body.scrollTop = body.scrollHeight;

      try {
        const res = await fetch('/api/ai/chat', {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer '+getToken() },
          body: JSON.stringify({ message: msg })
        });
        const data = await res.json();
        body.removeChild(body.lastChild);

        if (data.type === 'ticket') {
          body.innerHTML += `<div class="chat-msg assistant"><div class="avatar">🤖</div><div class="chat-bubble">
            已为您生成工单，请确认信息：<br><br>
            <div class="ticket-confirm" id="confirmCard">
              <input id="cfTitle" value="${data.title||''}"><br>
              <select id="cfGroup"><option ${data.group==='桌面运维'?'selected':''}>桌面运维</option><option ${data.group==='网络运维'?'selected':''}>网络运维</option><option ${data.group==='应用系统运维'?'selected':''}>应用系统运维</option></select><br>
              <textarea id="cfDesc" rows="2">${data.description||''}</textarea><br>
              <button class="btn-create" onclick="createTicket()">确认提交</button>
              <button class="btn-cancel" onclick="cancelTicket()">取消</button>
            </div>
          </div></div>`;
        } else {
          body.innerHTML += `<div class="chat-msg assistant"><div class="avatar">🤖</div><div class="chat-bubble">${data.content||'抱歉，请换个方式描述您的问题。'}</div></div>`;
        }
      } catch(e) {
        body.removeChild(body.lastChild);
        body.innerHTML += `<div class="chat-msg assistant"><div class="avatar">🤖</div><div class="chat-bubble">抱歉，服务暂时不可用，请稍后重试。</div></div>`;
      }
      body.scrollTop = body.scrollHeight;
    }

    async function createTicket() {
      const card = document.getElementById('confirmCard');
      card.innerHTML = '<div style="text-align:center;color:#2563eb;">提交中...</div>';
      try {
        const res = await fetch('/my-tickets', {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer '+getToken() },
          body: JSON.stringify({ title: document.getElementById('cfTitle').value, group: document.getElementById('cfGroup').value, body: document.getElementById('cfDesc').value })
        });
        if (res.ok) { location.href = 'list.html'; }
        else { card.innerHTML = '<div style="color:#ef4444;">提交失败，请重试</div>'; }
      } catch(e) { card.innerHTML = '<div style="color:#ef4444;">提交失败，请重试</div>'; }
    }

    function cancelTicket() {
      document.getElementById('confirmCard').innerHTML = '<div style="color:#9ca3af;">已取消</div>';
    }

    async function init() {
      const token = getToken();
      if (!token) { location.href = 'login.html'; return; }
      try {
        const res = await fetch('/auth/me', { headers: { 'Authorization': 'Bearer '+token } });
        if (!res.ok) throw new Error('auth');
        const data = await res.json();
        localStorage.setItem('it_role', data.role);
        document.getElementById('welcomeText').innerHTML = `<span>${data.name||'用户'}</span>，有什么可以帮您？`;
        document.getElementById('bottomNav').innerHTML = buildNav(data.role);
        // 加载工单数量
        fetch('/my-tickets?limit=2000', { headers: { 'Authorization': 'Bearer '+token } }).then(r => r.json()).then(d => {
          if (Array.isArray(d)) document.getElementById('ticketCount').textContent = d.length;
        }).catch(()=>{});
      } catch(e) { logout(); }
    }

    init();
  </script>
</body>
</html>
```

- [ ] **Step 2: Commit**

```bash
git add h5/home.html
git commit -m "feat: add portal home page with AI chat and shortcuts"
```

---

### Task 4: 修改登录跳转

**Files:**
- Modify: `h5/login.html` — 将两处 `location.href = 'list.html'` 改为 `location.href = 'home.html'`

- [ ] **Step 1: 替换登录跳转目标**

在 `h5/login.html` 中查找 `list.html` 替换为 `home.html`：

```bash
sed -i '' "s|location.href = 'list.html'|location.href = 'home.html'|g" h5/login.html
```

- [ ] **Step 2: 确认改动**

```bash
grep "location.href" h5/login.html
# 应输出两行，都是 home.html
```

- [ ] **Step 3: Commit**

```bash
git add h5/login.html
git commit -m "feat: redirect login to home.html as entry page"
```

---

### Task 5: 部署上线

- [ ] **Step 1: rsync 代码到服务器**

```bash
rsync -az --delete --exclude node_modules --exclude .git \
  -e "ssh -i ~/.ssh/id_ed25519_huiji" \
  /Users/huozhe/itsm/ huozhe@172.24.16.40:/tmp/itsm-build/
```

- [ ] **Step 2: 构建并推送镜像**

```bash
ssh huozhe@172.24.16.40 "sudo docker build -t harbor.szctdg.tech/itsm/itsm:v1.2.3 /tmp/itsm-build && sudo docker push harbor.szctdg.tech/itsm/itsm:v1.2.3"
```

- [ ] **Step 3: Helm 升级**

```bash
ssh huozhe@172.24.16.40 "sudo helm upgrade itsm /tmp/itsm-build/chart -n itsm --set image.tag=v1.2.3 --kubeconfig /etc/rancher/k3s/k3s.yaml"
```

- [ ] **Step 4: 重启 Pod**

```bash
ssh huozhe@172.24.16.40 "sudo kubectl --kubeconfig /etc/rancher/k3s/k3s.yaml -n itsm delete pods -l app=itsm"
```

- [ ] **Step 5: 验证**

打开 `https://172.24.16.40:3001` → 应跳转到 `home.html` → AI 对话可正常使用。

- [ ] **Step 6: Git tag & push**

```bash
git add -A && git commit -m "feat: ITSM portal with AI chat and smart ticket creation" && git tag v1.3.0 && git push origin main --tags
```
