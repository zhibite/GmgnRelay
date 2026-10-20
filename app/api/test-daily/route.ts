/**
 * 临时测试路由：验证 gmgn.ai daily_profits 能否从 Vercel 中转
 *
 * GET /api/test-daily?address=xxx
 *
 * 测试点：
 * 1. Vercel 服务器能否连通 gmgn.ai
 * 2. 能否不带 session 参数拿到数据
 * 3. 数据质量（对比 docs/gmgn-daily.md 的基准响应）
 */
import { NextRequest, NextResponse } from 'next/server';

const GMGN_DAILY_HOST = process.env.GMGN_DAILY_HOST ?? 'https://gmgn.ai';
const GMGN_DAILY_PATH = process.env.GMGN_DAILY_PATH ?? '/pf/api/v1/wallets/sol/daily_profits';

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const address = searchParams.get('address') ?? 'FHpcNSe6tb2n15bAdq4BkeYWGyZKFD7yLYrH92ng7wCT';
  const period = searchParams.get('period') ?? '30d';

  const url = `${GMGN_DAILY_HOST}${GMGN_DAILY_PATH}?address=${address}&period=${period}`;

  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; solwallet-relay/1.0)',
        'Accept': 'application/json',
        'Referer': GMGN_DAILY_HOST,
      },
    });

    const text = await res.text();
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }

    return NextResponse.json({
      ok: res.ok,
      status: res.status,
      statusText: res.statusText,
      url,
      headers: {
        'content-type': res.headers.get('content-type'),
        'x-gmgn-trace': res.headers.get('x-gmgn-trace'),
      },
      body: json,
      raw: text.slice(0, 500),
    });
  } catch (err: any) {
    return NextResponse.json({
      ok: false,
      error: err?.message ?? String(err),
      url,
    });
  }
}
