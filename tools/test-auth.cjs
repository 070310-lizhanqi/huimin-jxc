// 认证与隔离的端到端验证
const BASE = process.env.OC_BASE || 'http://127.0.0.1:7741/api';

async function req(method, path, body, token) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const r = await fetch(BASE + path, {
    method, headers, body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await r.json(); } catch { /* 非 JSON */ }
  return { status: r.status, data };
}

const results = [];
function check(name, cond, extra = '') {
  results.push({ name, ok: !!cond, extra });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
}

(async () => {
  // 1. 未登录访问业务接口
  let r = await req('GET', '/product');
  check('未登录访问业务接口被拦', r.status === 401, `status=${r.status}`);

  // 2. 错误密码
  r = await req('POST', '/auth/login', { username: 'admin', password: 'wrong' });
  check('错误密码被拒', r.status === 401, `status=${r.status}`);

  // 3. 正确登录
  r = await req('POST', '/auth/login', { username: 'admin', password: 'admin123456' });
  check('正确密码登录成功', r.status === 200 && !!r.data?.token, `status=${r.status}`);
  const token = r.data?.token;
  const teamId = r.data?.user?.teamId;

  // 4. me 接口
  r = await req('GET', '/auth/me', null, token);
  check('/auth/me 返回用户与团队', r.status === 200 && r.data?.team?.name === '鲜果批发部', JSON.stringify(r.data?.team));

  // 5. 带 token 建商品（伪造 teamId 999）
  r = await req('POST', '/product', { teamId: 999, name: '隔离测试商品', unit: '件', salePrice: 1000 }, token);
  check('伪造 teamId 创建商品被纠正到本团队', r.status === 200 && r.data?.teamId === teamId, `teamId=${r.data?.teamId}`);
  const createdProductId = r.data?.id;

  // 6. 伪造 teamId 查询
  r = await req('GET', '/product?teamId=999', null, token);
  check('伪造 teamId 查询仍只返回本团队数据', r.status === 200 && Array.isArray(r.data) && r.data.every((p) => p.teamId === teamId), `count=${r.data?.length}`);

  // 7. 无效 token
  r = await req('GET', '/product', null, 'invalid.token.here');
  check('伪造 token 被拒', r.status === 401, `status=${r.status}`);

  // 8. 篡改 token 载荷
  const [body, sig] = token.split('.');
  const tampered = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, 'base64').toString()), teamId: 999, exp: Math.floor(Date.now() / 1000) + 9999 })).toString('base64url');
  r = await req('GET', '/product', null, `${tampered}.${sig}`);
  check('篡改令牌载荷被签名校验拒绝', r.status === 401, `status=${r.status}`);

  // 9. 团队列表只返回自己的团队
  r = await req('GET', '/team/list', null, token);
  check('/team/list 只返回当前团队', r.status === 200 && r.data?.length === 1 && r.data[0].id === teamId, `len=${r.data?.length}`);

  // 10. 团队内加用户 + 新用户登录（用户名带时间戳，保证可重复运行）
  const clerkName = `clerk${Date.now().toString().slice(-6)}`;
  r = await req('POST', '/auth/users', { username: clerkName, password: 'clerk123456', role: 'clerk' }, token);
  check('管理员新增团队用户', r.status === 200 && r.data?.ok, `status=${r.status} ${r.data?.error || ''}`);
  const createdUserId = r.data?.id;
  r = await req('POST', '/auth/login', { username: clerkName, password: 'clerk123456' });
  check('新用户可登录且属同一团队', r.status === 200 && r.data?.user?.teamId === teamId, `teamId=${r.data?.user?.teamId}`);
  const clerkToken = r.data?.token;

  // 11. 普通角色不能加用户
  r = await req('POST', '/auth/users', { username: `x${Date.now().toString().slice(-6)}`, password: 'xxxxxx' }, clerkToken);
  check('非管理员不能新增用户', r.status === 403, `status=${r.status}`);

  // 12. 改密码
  r = await req('POST', '/auth/password', { oldPassword: 'wrong', newPassword: 'newpass123' }, token);
  check('改密码时原密码错误被拒', r.status === 400, `status=${r.status}`);
  r = await req('POST', '/auth/password', { oldPassword: 'admin123456', newPassword: 'admin123456' }, token);
  check('改密码成功（同密码回写）', r.status === 200, `status=${r.status}`);

  // 13. 重复注册
  r = await req('POST', '/auth/register', { username: 'admin2', password: 'admin123456' });
  check('已有账套时禁止再注册新团队', r.status === 400, `status=${r.status} ${r.data?.error || ''}`);

  const pass = results.filter((x) => x.ok).length;

  // 清理本次测试写入的数据，避免污染正式账套
  const cleanup = [
    ['DELETE', `/product/${createdProductId}`],
    ['DELETE', `/auth/users/${createdUserId}`],
  ];
  for (const [m, p] of cleanup) {
    if (!p || p.endsWith('undefined')) continue;
    const rr = await req(m, p, null, token);
    console.log(`清理 ${m} ${p} -> ${rr.status}`);
  }

  console.log(`\n===== PASS ${pass} / FAIL ${results.length - pass} =====`);
  process.exit(results.length - pass ? 1 : 0);
})();
