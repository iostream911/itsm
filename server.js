// IT服务台 - 预览服务器
// 功能：静态文件、JWT登录、Zammad API代理、自动派单、邮件通知
require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const path = require('path');

const PORT = 3000;
const ZAMMAD_URL = process.env.ZAMMAD_URL || 'http://localhost:8088';

// QQ 邮箱配置（请在环境变量中设置，或直接修改这里）
const EMAIL_USER = process.env.EMAIL_USER || '';
const EMAIL_PASS = process.env.EMAIL_PASS || ''; // QQ邮箱授权码，不是QQ密码
const EMAIL_FROM = process.env.EMAIL_FROM || EMAIL_USER;
const API_TOKEN = process.env.ZAMMAD_TOKEN || '请设置你的API Token';
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');

const app = express();
app.use(express.json());

// ── 内存用户存储（生产环境换成数据库）──
const users = {};           // phone -> { phone, name, zammadId, createdAt }
const verifyCodes = {};     // phone -> { code, expiresAt }

// ── JWT 工具 ──
function signToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '30d' });
}
function authMiddleware(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ error: '请先登录' });
  }
  try {
    req.user = jwt.verify(auth.slice(7), JWT_SECRET);
    next();
  } catch (e) {
    return res.status(401).json({ error: '登录已过期，请重新登录' });
  }
}

// ── 根据手机号查找或创建 Zammad 客户 ──
async function getOrCreateZammadCustomer(phone) {
  // 1. 先按手机号在 Zammad 中搜索已有用户（包括管理员、运维人员）
  const phoneRes = await fetch(
    `${ZAMMAD_URL}/api/v1/users/search?query=${encodeURIComponent(phone)}&limit=10`,
    { headers: { 'Authorization': `Token token=${API_TOKEN}` } }
  );
  const phoneList = await phoneRes.json();
  if (Array.isArray(phoneList)) {
    // 精确匹配手机号
    const match = phoneList.find(u => u.phone === phone);
    if (match) {
      console.log(`[用户] 手机号 ${phone} 匹配已有用户 ID:${match.id} (${match.login})`);
      return match.id;
    }
  }

  // 2. 再按默认邮箱搜索
  const email = `${phone}@it.local`;
  const emailRes = await fetch(
    `${ZAMMAD_URL}/api/v1/users/search?query=${encodeURIComponent(email)}&limit=1`,
    { headers: { 'Authorization': `Token token=${API_TOKEN}` } }
  );
  const emailList = await emailRes.json();
  if (Array.isArray(emailList) && emailList.length > 0 && emailList[0].id) {
    return emailList[0].id;
  }

  // 3. 都不存在才创建新客户
  console.log(`[用户] 手机号 ${phone} 未找到，创建新客户`);
  const createRes = await fetch(`${ZAMMAD_URL}/api/v1/users`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Token token=${API_TOKEN}`
    },
    body: JSON.stringify({
      email,
      phone,
      firstname: phone,
      lastname: '',
      login: phone,
      active: true,
      role_ids: [3]
    })
  });
  const newUser = await createRes.json();
  return newUser.id || null;
}

// ── 短信 API 配置 ──
const SMS_API_URL = process.env.SMS_API_URL || '';
const SMS_LOGIN_NAME = process.env.SMS_LOGIN_NAME || '';
const SMS_PASSWORD = process.env.SMS_PASSWORD || '';
const SMS_SIGNATURE = process.env.SMS_SIGNATURE || '';

// ── 发送短信验证码 ──
async function sendSMS(phone, code) {
  const now = new Date();
  const dateTime = now.getFullYear().toString() +
    (now.getMonth() + 1).toString().padStart(2, '0') +
    now.getDate().toString().padStart(2, '0') +
    now.getHours().toString().padStart(2, '0') +
    now.getMinutes().toString().padStart(2, '0') +
    now.getSeconds().toString().padStart(2, '0');

  const content = `${SMS_SIGNATURE}您的验证码是${code}，5分钟内有效。如非本人操作，请忽略。`;

  const params = new URLSearchParams();
  params.append('LoginName', SMS_LOGIN_NAME);
  params.append('Password', SMS_PASSWORD);
  params.append('Phones', phone);
  params.append('MsgContent', content);
  params.append('CorpId', process.env.SMS_CORP_ID || '');
  params.append('DateTime', dateTime);

  console.log(`[短信] 发送到 ${phone} | 验证码: ${code}`);

  try {
    const res = await fetch(`${SMS_API_URL}/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString()
    });
    const text = await res.text();
    console.log(`[短信] 响应: ${text}`);

    // batchNumber 存在表示成功
    if (text.includes('<batchNumber>') || text.includes('batchNumber')) {
      return { ok: true };
    }

    // 解析 <result> 标签
    const resultMatch = text.match(/<result>([^<]+)<\/result>/);
    const result = resultMatch?.[1] || '';
    if (result && result !== 'OK') {
      return { ok: false, error: `短信发送失败: ${result}` };
    }

    return { ok: true };
  } catch (err) {
    console.log(`[短信] 发送失败 ${phone}: ${err.message}`);
    return { ok: false, error: err.message };
  }
}
app.post('/auth/send-code', async (req, res) => {
  const { phone } = req.body;
  if (!phone || !/^1[3-9]\d{9}$/.test(phone)) {
    return res.json({ ok: false, error: '请输入正确的手机号' });
  }

  // 校验手机号是否在 Zammad 中注册
  try {
    const zammadUserId = await findZammadUserId(phone);
    if (!zammadUserId) {
      return res.json({ ok: false, error: '该手机号未注册，请联系管理员' });
    }
  } catch (e) {
    return res.json({ ok: false, error: '系统繁忙，请稍后重试' });
  }

  // 生成6位验证码
  const code = String(Math.floor(100000 + Math.random() * 900000));
  verifyCodes[phone] = { code, expiresAt: Date.now() + 5 * 60 * 1000 };

  console.log(`\n  📱 验证码 [${phone}]: ${code}  (5分钟有效)\n`);

  // 如果配置了短信 API，则发送真实短信
  if (SMS_API_URL && SMS_LOGIN_NAME && SMS_PASSWORD) {
    const result = await sendSMS(phone, code);
    if (result.ok) {
      return res.json({ ok: true, message: '验证码已发送' });
    }
    // 短信发送失败，删除验证码记录
    delete verifyCodes[phone];
    return res.json({ ok: false, error: '短信发送失败，请重试' });
  }

  // 未配置短信 API 时回退到演示模式
  res.json({ ok: true, demo_code: code, message: '验证码已发送（演示模式）' });
});

// ── 判断角色 ──
function getRole(roleIds) {
  if (!roleIds || !Array.isArray(roleIds)) return 'customer';
  if (roleIds.includes(1)) return 'admin';
  if (roleIds.includes(2)) return 'agent';
  return 'customer';
}

// ── 从 Zammad 查找用户角色 ──
async function fetchZammadUserRole(phone) {
  try {
    // 按手机号搜索（Zammad phone 字段 & email 中的 phone@it.local 模式）
    let res = await fetch(`${ZAMMAD_URL}/api/v1/users/search?query=${encodeURIComponent(phone)}&limit=5`, {
      headers: { 'Authorization': `Token token=${API_TOKEN}` }
    });
    let list = await res.json();
    if (Array.isArray(list) && list.length > 0) {
      // 精确匹配：phone 字段或 email 以 phone 开头
      const match = list.find(u => u.phone === phone || (u.email && u.email.startsWith(phone)));
      if (match) return getRole(match.role_ids || []);
    }
    // Fallback: email 拼接搜索
    res = await fetch(`${ZAMMAD_URL}/api/v1/users/search?query=${encodeURIComponent(phone + '@it.local')}&limit=1`, {
      headers: { 'Authorization': `Token token=${API_TOKEN}` }
    });
    list = await res.json();
    if (Array.isArray(list) && list.length > 0) {
      return getRole(list[0].role_ids || []);
    }
  } catch (e) { /* ignore */ }
  return 'customer';
}

// ── 验证码登录 ──
app.post('/auth/login', async (req, res) => {
  const { phone, code } = req.body;
  if (!phone || !code) {
    return res.json({ ok: false, error: '请输入手机号和验证码' });
  }
  const record = verifyCodes[phone];
  if (!record) {
    return res.json({ ok: false, error: '请先获取验证码' });
  }
  if (Date.now() > record.expiresAt) {
    delete verifyCodes[phone];
    return res.json({ ok: false, error: '验证码已过期' });
  }
  if (record.code !== code) {
    return res.json({ ok: false, error: '验证码错误' });
  }
  delete verifyCodes[phone];

  // 登记用户
  if (!users[phone]) {
    users[phone] = { phone, name: phone, createdAt: new Date().toISOString() };
  }

  // 从 Zammad 查角色
  const role = await fetchZammadUserRole(phone);
  users[phone].role = role;

  const token = signToken({ phone, role });
  res.json({ ok: true, token, phone, role, name: users[phone].name });
});

// ── 获取当前用户信息 + 刷新 Token ──
app.get('/auth/me', authMiddleware, async (req, res) => {
  const u = users[req.user.phone];
  // 每次验证时同步 Zammad 角色
  const role = await fetchZammadUserRole(req.user.phone);
  if (u) u.role = role;
  const token = signToken({ phone: req.user.phone, role });
  res.json({ phone: req.user.phone, role, name: u?.name || req.user.phone, token });
});

// ── 获取当前用户的工单列表 ──
// ── 按手机号查找 Zammad 用户 ID ──
async function findZammadUserId(phone) {
  const candidates = await fetch(
    `${ZAMMAD_URL}/api/v1/users/search?query=${encodeURIComponent(phone)}&limit=10`,
    { headers: { 'Authorization': `Token token=${API_TOKEN}` } }
  );
  const list = await candidates.json();
  if (Array.isArray(list)) {
    const match = list.find(u => u.phone === phone);
    if (match) return match.id;
    // 退而求其次：邮箱匹配
    const emailMatch = list.find(u => u.email === `${phone}@it.local`);
    if (emailMatch) return emailMatch.id;
  }
  return null;
}

app.get('/my-tickets', authMiddleware, async (req, res) => {
  try {
    const phone = req.user.phone;
    const customerId = await findZammadUserId(phone);

    if (!customerId) return res.json([]);

    const allRes = await fetch(
      `${ZAMMAD_URL}/api/v1/tickets?expand=true`,
      { headers: { 'Authorization': `Token token=${API_TOKEN}` } }
    );
    const allTickets = await allRes.json();
    const myTickets = Array.isArray(allTickets)
      ? allTickets.filter(t => t.customer_id === customerId).sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
      : [];
    res.json(myTickets);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── 邮件发送 ──
let mailTransporter = null;
function getMailer() {
  if (!EMAIL_USER || !EMAIL_PASS) return null;
  if (!mailTransporter) {
    mailTransporter = nodemailer.createTransport({
      host: 'smtp.qq.com',
      port: 465,
      secure: true,
      auth: { user: EMAIL_USER, pass: EMAIL_PASS }
    });
  }
  return mailTransporter;
}

async function sendAssignmentEmail(ticket, agentEmail, agentName) {
  const mailer = getMailer();
  if (!mailer) return console.log('[邮件] 未配置邮箱，跳过发送');
  try {
    await mailer.sendMail({
      from: `IT服务中心 <${EMAIL_FROM}>`,
      to: agentEmail,
      bcc: EMAIL_USER, // 抄送管理员
      subject: `【新工单】#${ticket.number} ${ticket.title}`,
      html: `
        <h3>您有一个新的IT工单需要处理</h3>
        <table style="border-collapse:collapse;width:100%;max-width:500px;">
          <tr><td style="padding:8px;border:1px solid #e5e7eb;background:#f9fafb;width:80px;">工单编号</td><td style="padding:8px;border:1px solid #e5e7eb;">#${ticket.number}</td></tr>
          <tr><td style="padding:8px;border:1px solid #e5e7eb;background:#f9fafb;">标题</td><td style="padding:8px;border:1px solid #e5e7eb;">${ticket.title}</td></tr>
          <tr><td style="padding:8px;border:1px solid #e5e7eb;background:#f9fafb;">分组</td><td style="padding:8px;border:1px solid #e5e7eb;">${ticket.group || '-'}</td></tr>
          <tr><td style="padding:8px;border:1px solid #e5e7eb;background:#f9fafb;">处理人</td><td style="padding:8px;border:1px solid #e5e7eb;">${agentName}</td></tr>
        </table>
        <p style="margin-top:16px;">请登录 Zammad 处理：<a href="http://localhost:8088">http://localhost:8088</a></p>
      `
    });
    console.log(`[邮件] 已发送通知给 ${agentEmail}`);
  } catch (err) {
    console.log(`[邮件] 发送失败: ${err.message}`);
  }
}

// ── 自动派单：按分组找负载最低的处理人 ──
async function autoAssign(ticketId, groupName) {
  try {
    // 1. 获取分组 ID
    const groupRes = await fetch(`${ZAMMAD_URL}/api/v1/groups`, {
      headers: { 'Authorization': `Token token=${API_TOKEN}` }
    });
    const groups = await groupRes.json();
    const group = (Array.isArray(groups) ? groups : []).find(g => g.name === groupName);
    if (!group) return console.log(`[派单] 找不到分组: ${groupName}`);

    // 2. 获取该分组的处理人
    const agentsRes = await fetch(`${ZAMMAD_URL}/api/v1/users?expand=true&limit=100`, {
      headers: { 'Authorization': `Token token=${API_TOKEN}` }
    });
    const allUsers = await agentsRes.json();
    const agents = (Array.isArray(allUsers) ? allUsers : [])
      .filter(u => (u.role_ids || []).includes(2)) // 只取 Agent 角色
      .filter(u => {
        const gids = u.group_ids || {};
        return Object.keys(gids).some(gid => gids[gid] && groups.find(g => g.id == gid && g.name === groupName));
      })
      .filter(u => u.id !== 3); // 排除管理员，不参与自动派单

    if (agents.length === 0) return console.log(`[派单] 分组 ${groupName} 暂无处理人`);

    // 3. VIP 优先：如果该组有 VIP 运维人员，则只看 VIP
    const vipAgents = agents.filter(a => a.vip === true);
    const candidates = vipAgents.length > 0 ? vipAgents : agents;
    const vipLabel = vipAgents.length > 0 ? ' [VIP优先]' : '';

    // 4. 找负载最低的（拥有最少 open 工单的处理人）
    const ticketsRes = await fetch(`${ZAMMAD_URL}/api/v1/tickets?expand=true`, {
      headers: { 'Authorization': `Token token=${API_TOKEN}` }
    });
    const allTickets = await ticketsRes.json();
    const ticketList = Array.isArray(allTickets) ? allTickets : [];

    let bestAgent = candidates[0];
    let minLoad = Infinity;
    for (const agent of candidates) {
      const load = ticketList.filter(t => t.owner_id === agent.id && ![4,5].includes(t.state_id)).length;
      if (load < minLoad) { minLoad = load; bestAgent = agent; }
    }

    // 4. 分配工单
    await fetch(`${ZAMMAD_URL}/api/v1/tickets/${ticketId}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Token token=${API_TOKEN}`
      },
      body: JSON.stringify({ owner_id: bestAgent.id, state_id: 2 }) // 分配后自动改为"已打开"状态
    });
    console.log(`[派单] 工单 #${ticketId} → ${bestAgent.firstname}${bestAgent.lastname || ''} (${bestAgent.email}) (负载: ${minLoad})${vipLabel}`);

    // 5. 发送邮件通知
    const ticketRes = await fetch(`${ZAMMAD_URL}/api/v1/tickets/${ticketId}?expand=true`, {
      headers: { 'Authorization': `Token token=${API_TOKEN}` }
    });
    const ticket = await ticketRes.json();
    await sendAssignmentEmail(ticket, bestAgent.email, `${bestAgent.firstname}${bestAgent.lastname || ''}`);

    return bestAgent;
  } catch (err) {
    console.log(`[派单] 错误: ${err.message}`);
    return null;
  }
}

// ── 提交工单（自动绑定当前用户 + 自动派单）──
app.post('/my-tickets', authMiddleware, async (req, res) => {
  try {
    const { title, group, body, location, priority_id } = req.body;
    const phone = req.user.phone;
    const customerId = await getOrCreateZammadCustomer(phone);

    if (!customerId) {
      return res.status(500).json({ error: '创建客户失败' });
    }

    // 更新本地用户记录
    if (users[phone]) users[phone].zammadId = customerId;

    // 构建工单内容（包含地点信息）
    const articleBody = location ? `【地点：${location}】\n${body || ''}` : (body || '');

    const ticketRes = await fetch(`${ZAMMAD_URL}/api/v1/tickets`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Token token=${API_TOKEN}`
      },
      body: JSON.stringify({
        title: title || body?.substring(0, 50) || 'IT服务申请',
        group: group || '桌面运维',
        customer_id: customerId,
        article: {
          body: articleBody,
          type: 'note',
          subject: title || '',
          content_type: 'text/plain'
        },
        priority_id: priority_id || 2
      })
    });

    const data = await ticketRes.json();
    if (!ticketRes.ok) return res.status(ticketRes.status).json(data);

    // 自动派单（异步，不阻塞响应）
    const ticketId = data.id;
    const ticketNumber = data.number;
    autoAssign(ticketId, group || '桌面运维').then(agent => {
      if (agent) console.log(`[派单] 工单 #${ticketNumber} 已自动分配给 ${agent.email}`);
    });

    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── 工单更新（关闭/分配分组/分配处理人）──
app.put('/api/v1/tickets/:id', async (req, res) => {
  try {
    const ticketId = req.params.id;
    const body = { ...req.body };

    // 检测是否新增/变更处理人
    if (body.owner_id && body.owner_id > 1) {
      // 获取当前工单信息
      const oldRes = await fetch(`${ZAMMAD_URL}/api/v1/tickets/${ticketId}?expand=true`, {
        headers: { 'Authorization': `Token token=${API_TOKEN}` }
      });
      const oldTicket = await oldRes.json();

      // 如果是新分配处理人（之前未分配或不同人）
      if (oldTicket.owner_id !== body.owner_id && ![4,5].includes(oldTicket.state_id)) {
        body.state_id = body.state_id || 2; // 改为"已打开"

        // 自动匹配分组：确保新处理人在工单的分组内
        if (!body.group && !body.group_id) {
          const agentRes = await fetch(`${ZAMMAD_URL}/api/v1/users/${body.owner_id}?expand=true`, {
            headers: { 'Authorization': `Token token=${API_TOKEN}` }
          });
          const agent = await agentRes.json();
          const agentGroups = Object.keys(agent.groups || {}).filter(g => g !== 'Users');
          // 如果当前工单分组不在处理人的分组列表中，自动切换到处理人的第一个分组
          if (agentGroups.length > 0 && !agentGroups.includes(oldTicket.group)) {
            body.group = agentGroups[0];
          }
        }
      }
    }

    // 更新 Zammad
    const ticketRes = await fetch(`${ZAMMAD_URL}/api/v1/tickets/${ticketId}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Token token=${API_TOKEN}`
      },
      body: JSON.stringify(body)
    });
    const data = await ticketRes.json();

    // 分配处理人后发送邮件通知
    if (ticketRes.ok && body.owner_id && body.owner_id > 1) {
      try {
        const [tRes, oRes] = await Promise.all([
          fetch(`${ZAMMAD_URL}/api/v1/tickets/${ticketId}?expand=true`, { headers: { 'Authorization': `Token token=${API_TOKEN}` } }),
          fetch(`${ZAMMAD_URL}/api/v1/users/${body.owner_id}`, { headers: { 'Authorization': `Token token=${API_TOKEN}` } })
        ]);
        const ticket = await tRes.json();
        const owner = await oRes.json();
        const mailer = getMailer();
        if (mailer && owner.email) {
          await mailer.sendMail({
            from: `IT服务中心 <${EMAIL_FROM}>`,
            to: owner.email,
            bcc: EMAIL_USER,
            subject: `【新工单指派】#${ticket.number} ${ticket.title}`,
            html: `<h3>工单已分配给您</h3>
              <table style="border-collapse:collapse;width:100%;max-width:500px;">
              <tr><td style="padding:8px;border:1px solid #e5e7eb;background:#f9fafb;width:80px;">工单编号</td><td style="padding:8px;border:1px solid #e5e7eb;">#${ticket.number}</td></tr>
              <tr><td style="padding:8px;border:1px solid #e5e7eb;background:#f9fafb;">标题</td><td style="padding:8px;border:1px solid #e5e7eb;">${ticket.title}</td></tr>
              <tr><td style="padding:8px;border:1px solid #e5e7eb;background:#f9fafb;">分组</td><td style="padding:8px;border:1px solid #e5e7eb;">${ticket.group||'-'}</td></tr>
              <tr><td style="padding:8px;border:1px solid #e5e7eb;background:#f9fafb;">处理人</td><td style="padding:8px;border:1px solid #e5e7eb;">${owner.firstname||''} ${owner.lastname||''}</td></tr></table>
              <p style="margin-top:16px;">请登录处理：<a href="http://localhost:8088">Zammad</a></p>`
          });
          console.log(`[分配] 工单 #${ticket.number} 分配给 ${owner.email}，邮件已通知`);
        }
      } catch (e) { console.log('[分配] 邮件发送失败:', e.message); }
    }

    res.status(ticketRes.status).json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── 用户信息更新（修改角色等）──
app.put('/api/v1/users/:id', async (req, res) => {
  try {
    const userRes = await fetch(`${ZAMMAD_URL}/api/v1/users/${req.params.id}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Token token=${API_TOKEN}`
      },
      body: JSON.stringify(req.body)
    });
    const data = await userRes.json();
    res.status(userRes.status).json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── 运维人员看板（只看分配给自己的工单）──
app.get('/my-dashboard', authMiddleware, async (req, res) => {
  try {
    if (req.user.role === 'customer') {
      return res.status(403).json({ error: '权限不足' });
    }
    const phone = req.user.phone;
    const userId = await findZammadUserId(phone);
    if (!userId) return res.json([]);

    // 获取所有工单，过滤分配给自己的
    const allRes = await fetch(`${ZAMMAD_URL}/api/v1/tickets?expand=true`, {
      headers: { 'Authorization': `Token token=${API_TOKEN}` }
    });
    const allTickets = await allRes.json();
    const myTickets = Array.isArray(allTickets)
      ? allTickets.filter(t => t.owner_id === userId).sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
      : [];
    res.json(myTickets);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── 添加工单回复（运维人员沟通）──
app.post('/api/v1/ticket_articles', async (req, res) => {
  try {
    const articleRes = await fetch(`${ZAMMAD_URL}/api/v1/ticket_articles`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Token token=${API_TOKEN}`
      },
      body: JSON.stringify(req.body)
    });
    const data = await articleRes.json();
    res.status(articleRes.status).json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── 转派通知 ──
app.post('/api/v1/tickets/:id/transfer-notify', async (req, res) => {
  try {
    const ticketId = req.params.id;
    const newOwnerId = req.body.new_owner_id;

    const [tRes, oRes] = await Promise.all([
      fetch(`${ZAMMAD_URL}/api/v1/tickets/${ticketId}?expand=true`, { headers: { 'Authorization': `Token token=${API_TOKEN}` } }),
      fetch(`${ZAMMAD_URL}/api/v1/users/${newOwnerId}`, { headers: { 'Authorization': `Token token=${API_TOKEN}` } })
    ]);
    const ticket = await tRes.json();
    const newOwner = await oRes.json();

    const mailer = getMailer();
    if (mailer) {
      const ownerEmail = newOwner.email;
      const ownerName = (newOwner.firstname||'') + (newOwner.lastname||'');
      await mailer.sendMail({
        from: `IT服务中心 <${EMAIL_FROM}>`,
        to: ownerEmail,
        bcc: EMAIL_USER,
        subject: `【工单转派】#${ticket.number} ${ticket.title}`,
        html: `
          <h3>工单已转派给您</h3>
          <table style="border-collapse:collapse;width:100%;max-width:500px;">
            <tr><td style="padding:8px;border:1px solid #e5e7eb;background:#f9fafb;width:80px;">工单编号</td><td style="padding:8px;border:1px solid #e5e7eb;">#${ticket.number}</td></tr>
            <tr><td style="padding:8px;border:1px solid #e5e7eb;background:#f9fafb;">标题</td><td style="padding:8px;border:1px solid #e5e7eb;">${ticket.title}</td></tr>
            <tr><td style="padding:8px;border:1px solid #e5e7eb;background:#f9fafb;">分组</td><td style="padding:8px;border:1px solid #e5e7eb;">${ticket.group||'-'}</td></tr>
            <tr><td style="padding:8px;border:1px solid #e5e7eb;background:#f9fafb;">新处理人</td><td style="padding:8px;border:1px solid #e5e7eb;">${ownerName}</td></tr>
          </table>
          <p style="margin-top:16px;">请登录处理：<a href="http://localhost:8088">Zammad</a></p>
        `
      });
      console.log(`[转派] 工单 #${ticket.number} 已转派给 ${ownerName}，邮件已通知`);
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── 用户催办 ──
app.post('/my-tickets/:id/urge', authMiddleware, async (req, res) => {
  try {
    const ticketId = req.params.id;
    const phone = req.user.phone;

    // 获取工单详情
    const tRes = await fetch(`${ZAMMAD_URL}/api/v1/tickets/${ticketId}?expand=true`, {
      headers: { 'Authorization': `Token token=${API_TOKEN}` }
    });
    const ticket = await tRes.json();

    // 验证是否本人（使用统一查找函数）
    const myId = await findZammadUserId(phone);
    if (!myId || ticket.customer_id !== myId) {
      return res.status(403).json({ error: '无权操作' });
    }

    // 获取处理人信息
    let ownerEmail = '';
    let ownerName = '';
    if (ticket.owner_id && ticket.owner_id > 1) {
      const oRes = await fetch(`${ZAMMAD_URL}/api/v1/users/${ticket.owner_id}`, {
        headers: { 'Authorization': `Token token=${API_TOKEN}` }
      });
      const owner = await oRes.json();
      ownerEmail = owner.email || '';
      ownerName = (owner.firstname || '') + (owner.lastname || '');
    }

    // 发送催办邮件给管理员和处理人
    const mailer = getMailer();
    if (mailer) {
      const recipients = [EMAIL_USER];
      if (ownerEmail && ownerEmail !== EMAIL_USER) recipients.push(ownerEmail);

      for (const to of recipients) {
        await mailer.sendMail({
          from: `IT服务中心 <${EMAIL_FROM}>`,
          to,
          subject: `【催办】用户催促处理工单 #${ticket.number}`,
          html: `
            <h3>用户催促处理工单</h3>
            <table style="border-collapse:collapse;width:100%;max-width:500px;">
              <tr><td style="padding:8px;border:1px solid #e5e7eb;background:#f9fafb;width:80px;">工单编号</td><td style="padding:8px;border:1px solid #e5e7eb;">#${ticket.number}</td></tr>
              <tr><td style="padding:8px;border:1px solid #e5e7eb;background:#f9fafb;">标题</td><td style="padding:8px;border:1px solid #e5e7eb;">${ticket.title}</td></tr>
              <tr><td style="padding:8px;border:1px solid #e5e7eb;background:#f9fafb;">处理人</td><td style="padding:8px;border:1px solid #e5e7eb;">${ownerName || '未分配'}</td></tr>
              <tr><td style="padding:8px;border:1px solid #e5e7eb;background:#f9fafb;">催促人</td><td style="padding:8px;border:1px solid #e5e7eb;">${phone}</td></tr>
            </table>
            <p style="margin-top:16px;color:#dc2626;">请尽快处理该工单！</p>
          `
        }).catch(e => console.log('[邮件] 发送失败:', e.message));
      }
      console.log(`[催办] 工单 #${ticket.number} 已发送催办邮件`);
    }

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 静态文件
app.use(express.static(path.join(__dirname, 'h5')));

// 通用 API 代理（管理看板等使用）
app.use('/api', createProxyMiddleware({
  target: ZAMMAD_URL,
  changeOrigin: true,
  pathRewrite: (p) => '/api' + p,
  on: {
    proxyReq: (proxyReq, req) => {
      proxyReq.removeHeader('cookie');
      proxyReq.removeHeader('origin');
      proxyReq.removeHeader('referer');
      proxyReq.setHeader('Authorization', `Token token=${API_TOKEN}`);
    }
  }
}));

// 启动
app.listen(PORT, async () => {
  try {
    const r = await fetch(`${ZAMMAD_URL}/api/v1/tickets?limit=1`, {
      headers: { 'Authorization': `Token token=${API_TOKEN}` }
    });
    console.log(r.ok ? '  ✅ Zammad 连接正常' : '  ⚠️ Zammad 连接异常');
  } catch (e) { console.log('  ⚠️ Zammad 连接失败'); }

  console.log(`\n  🔐 登录页:      http://localhost:${PORT}/login.html`);
  console.log(`  📱 提交工单:    http://localhost:${PORT}/submit.html`);
  console.log(`  📋 我的工单:    http://localhost:${PORT}/list.html`);
  console.log(`  🖥️ 管理看板:    http://localhost:${PORT}/admin.html\n`);
});
