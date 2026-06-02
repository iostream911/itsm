// 人员同步脚本 — 从 SSO 接口导入用户到 Zammad
// 用法: node scripts/sync-users.js
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const SSO_URL = 'http://sso.szctdg.com:8080/WLUM/api/sync/user';
const SSO_PARAMS = '?appName=lzda-new&appKey=fd1939d88d0d4743835731d40ea0705c&startNum=0&orderParam=deptId&pageSize=5000&startSequence=0';
const ZAMMAD_URL = 'http://localhost:8088';
const API_TOKEN = process.env.ZAMMAD_TOKEN || '';
const TEST_LIMIT = 15; // 测试模式：只导 15 条
const BATCH_DELAY = 200;

if (!API_TOKEN) {
  console.error('请在 .env 中设置 ZAMMAD_TOKEN');
  process.exit(1);
}

// 从 DN 中提取组织路径（拼接所有 OU）
// 例: CN=xxx,OU=财务部,OU=苏州万和商旅,OU=苏州文旅集团,DC=szctdg,DC=com → 财务部/苏州万和商旅/苏州文旅集团
function extractOrg(dn) {
  if (!dn) return '';
  const parts = dn.split(',');
  const ouList = [];
  for (const p of parts) {
    const trimmed = p.trim();
    if (trimmed.startsWith('OU=')) {
      const name = trimmed.substring(3);
      // 跳过通用 OU
      if (name === '普通用户' || name === 'Users') continue;
      ouList.push(name);
    }
  }
  return ouList.join('/');
}

// 按名称查找或创建 Zammad 组织
async function findOrCreateOrg(name) {
  if (!name) return null;
  const headers = { Authorization: `Token token=${API_TOKEN}` };

  // 搜索
  const searchRes = await fetch(
    `${ZAMMAD_URL}/api/v1/organizations/search?query=${encodeURIComponent(name)}&limit=1`,
    { headers }
  );
  const searchList = await searchRes.json();
  if (Array.isArray(searchList) && searchList.length > 0) {
    const match = searchList.find(o => o.name === name);
    if (match) return match.id;
  }

  // 创建
  const createRes = await fetch(`${ZAMMAD_URL}/api/v1/organizations`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, active: true })
  });
  const data = await createRes.json();
  if (createRes.ok && data.id) return data.id;
  console.error(`  创建组织失败 ${name}: ${JSON.stringify(data)}`);
  return null;
}

async function fetchUsers() {
  console.log('[SSO] 获取用户数据...');
  const res = await fetch(SSO_URL + SSO_PARAMS);
  const data = await res.json();
  if (data.code !== 200) {
    console.error('[SSO] 接口异常:', data);
    process.exit(1);
  }
  return data.result;
}

async function searchZammadUser(account) {
  const res = await fetch(
    `${ZAMMAD_URL}/api/v1/users/search?query=${encodeURIComponent(account)}&limit=3`,
    { headers: { Authorization: `Token token=${API_TOKEN}` } }
  );
  const list = await res.json();
  if (Array.isArray(list)) {
    return list.find(u => u.login === account) || null;
  }
  return null;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  const allUsers = await fetchUsers();
  console.log(`[SSO] 获取到 ${allUsers.length} 条记录`);

  // 筛选：syncType=1 + state=1 + 有手机号
  const validUsers = [];
  for (const u of allUsers) {
    const sc = u.syncContent?.[0] || {};
    const mobile = (sc.mobile || '').trim();
    const state = sc.state;
    const syncType = u.syncType;
    if (syncType === '1' && state === 1 && mobile) {
      validUsers.push({
        account: sc.account,
        name: sc.name,
        mobile,
        email: sc.email || '',
        orgName: extractOrg(sc.dn || ''),
        orgid: sc.orgid || ''
      });
    }
  }
  console.log(`[筛选] 符合条件 (syncType=1 + state=1 + 手机): ${validUsers.length} 人`);

  // 测试模式
  const toImport = validUsers.slice(0, TEST_LIMIT);
  console.log(`[测试] 导入前 ${toImport.length} 条\n`);

  // 缓存组织 ID
  const orgCache = new Map();

  let created = 0, updated = 0, failed = 0;

  for (let i = 0; i < toImport.length; i++) {
    const user = toImport[i];
    try {
      // 解析组织
      let orgId = null;
      if (user.orgName && !orgCache.has(user.orgName)) {
        orgId = await findOrCreateOrg(user.orgName);
        if (orgId) orgCache.set(user.orgName, orgId);
      } else if (user.orgName) {
        orgId = orgCache.get(user.orgName);
      }

      const payload = {
        login: user.account,
        firstname: user.name,
        lastname: '',
        phone: user.mobile,
        email: user.email || `${user.account}@it.local`,
        active: true,
        role_ids: [3]
      };
      if (orgId) payload.organization_id = orgId;

      const existing = await searchZammadUser(user.account);
      if (existing) {
        // 更新
        const res = await fetch(`${ZAMMAD_URL}/api/v1/users/${existing.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', Authorization: `Token token=${API_TOKEN}` },
          body: JSON.stringify(payload)
        });
        if (res.ok) {
          updated++;
          process.stdout.write('u');
        } else {
          const d = await res.json();
          console.error(`\n  更新失败 ${user.account}: ${JSON.stringify(d)}`);
          failed++;
          process.stdout.write('x');
        }
      } else {
        // 创建
        const res = await fetch(`${ZAMMAD_URL}/api/v1/users`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Token token=${API_TOKEN}` },
          body: JSON.stringify(payload)
        });
        const data = await res.json();
        if (res.ok && data.id) {
          created++;
          process.stdout.write('+');
        } else {
          console.error(`\n  创建失败 ${user.account}: ${JSON.stringify(data)}`);
          failed++;
          process.stdout.write('x');
        }
      }
    } catch (e) {
      failed++;
      process.stdout.write('x');
    }

    if ((i + 1) % 5 === 0 || i === toImport.length - 1) {
      console.log(`  ${i + 1}/${toImport.length} (新增:${created} 更新:${updated} 失败:${failed})`);
    }
    if (i < toImport.length - 1) await sleep(BATCH_DELAY);
  }

  console.log(`\n[完成] 新增 ${created} | 更新 ${updated} | 失败 ${failed}`);
  console.log(`[组织] 创建了 ${orgCache.size} 个部门`);
}

main().catch(e => { console.error(e); process.exit(1); });
