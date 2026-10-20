/**
 * /api/pool/gmgn-batch
 *
 * POST - 批量取多个地址的 GMGN 盈利数据（跟单池列表页用）
 *
 * Body: { addresses: string[], period?: '30d' | '7d' | '24h' }
 *
 * 设计要点：
 *  - GMGN 是计费 API，池子动辄几百个地址，所以整批只发一次请求并整体缓存，
 *    不按地址逐个缓存（否则 N 个地址 = N 次上游调用）。
 *  - 缓存键含地址集合本身，所以列表变化天然失效；命中率高时不会打上游。
 *  - 上游失败时把错误透出（502），但不缓存失败结果。
 */
import { NextRequest, NextResponse } from 'next/server';
import { Cache } from '@/lib/cache';
import { getWalletProfits, GmgnError } from '@/lib/gmgn';

/** 盈利数据是慢变量，30d/7d 口径 30 分钟足够新鲜 */
const TTL_SEC = 1800;

// Vercel：批量会分片串行打上游，200 个地址 = 10 次请求，给足函数时长。
// Hobby 默认 10s 会被打断；Pro 可到 60s。
export const maxDuration = 60;
// 必须 Node runtime：src/lib/gmgn.ts 用了 node:crypto
// Next 16 只有 Node runtime（Edge 已被移除），不需要再声明 runtime。

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const period = (body.period ?? '30d') as '30d' | '7d' | '24h';

    const addresses = [...new Set<string>(Array.isArray(body.addresses) ? body.addresses : [])].filter(
      (a) => typeof a === 'string' && a.length >= 32 && a.length <= 44,
    );

    if (!addresses.length) {
      return NextResponse.json({ ok: false, error: 'no valid addresses' }, { status: 400 });
    }

    // 上限保护：避免单次请求把上游打爆
    const capped = addresses.slice(0, 200);
    const truncated = addresses.length > capped.length;

    const cacheKey = `gmgn:profits:${period}:${capped.join(',')}`;

    const results = await Cache.wrap<Record<string, unknown>>(cacheKey, TTL_SEC, async () => {
      const list = await getWalletProfits('sol', period, capped);
      const map: Record<string, unknown> = {};
      for (const item of list) {
        const addr = (item.address ?? item.wallet_address ?? item.wallet) as string | undefined;
        if (addr) map[addr] = item;
      }
      return map;
    });

    return NextResponse.json({
      ok: true,
      data: { period, results, truncated, requested: addresses.length },
    });
  } catch (err: any) {
    const msg = err instanceof GmgnError ? err.message : (err?.message ?? String(err));
    console.error('[/api/pool/gmgn-batch]', msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 502 });
  }
}