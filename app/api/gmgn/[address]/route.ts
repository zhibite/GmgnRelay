/**
 * /api/pool/[address]/gmgn
 *
 * GET - 单地址的 GMGN 盈利数据（池子详情页 / 单钱包卡片用）
 *
 * Query:
 *   period  30d | 7d | 24h      (default 30d)
 *   source  profits | daily     (default profits)
 *   days    daily 模式下回看天数 (default 30)
 *
 * 注意：source=daily 的上游路径未经验证，见 src/lib/gmgn.ts 注释。
 */
import { NextRequest, NextResponse } from 'next/server';
import { Cache } from '@/lib/cache';
import { getWalletProfits, getDailyProfits, GmgnError } from '@/lib/gmgn';

const TTL_SEC = 1800;

export const maxDuration = 30;

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ address: string }> },
) {
  try {
    const { address } = await params;
    const { searchParams } = new URL(req.url);

    const period = (searchParams.get('period') ?? '30d') as '30d' | '7d' | '24h';
    const source = searchParams.get('source') ?? 'profits';
    const days = Math.min(Math.max(parseInt(searchParams.get('days') ?? '30', 10) || 30, 1), 365);

    if (!address || address.length < 32 || address.length > 44) {
      return NextResponse.json({ ok: false, error: 'invalid address' }, { status: 400 });
    }

    if (source === 'daily') {
      const cacheKey = `gmgn:daily:sol:${address}:${days}`;
      const list = await Cache.wrap(cacheKey, TTL_SEC, () => getDailyProfits('sol', address, days));
      return NextResponse.json({ ok: true, data: { source: 'daily', address, days, list } });
    }

    const cacheKey = `gmgn:profit:sol:${address}:${period}`;
    const list = await Cache.wrap(cacheKey, TTL_SEC, () => getWalletProfits('sol', period, [address]));

    return NextResponse.json({
      ok: true,
      data: { source: 'profits', address, period, profit: list[0] ?? null },
    });
  } catch (err: any) {
    const msg = err instanceof GmgnError ? err.message : (err?.message ?? String(err));
    console.error('[/api/pool/[address]/gmgn]', msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 502 });
  }
}