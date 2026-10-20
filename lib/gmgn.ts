/**
 * GMGN Open API 客户端（部署在 Vercel / 海外服务器时使用）
 *
 * 认证：X-APIKEY header + URL query 里的 timestamp + client_id
 *
 * ── 端点可信度分级（重要）────────────────────────────────────────────
 *  verified  = /v1/user/wallet_profits
 *              来源：scripts/probe-gmgn-profits.mjs，与官方 Agent API 一致。
 *  unverified= 下面 getDailyProfits 的路径。docs/gmgn-daily.md 里记录的
 *              `gmgn.ai/pf/api/v1/wallets/sol/daily_profits` 是 GMGN 网页
 *              自己的内部接口（需要网页 session 的 device_id / fp_did），
 *              **不等于** openapi 主机上的 /v1 路径。本机网络不通，
 *              无法验证，所以做成 env 可覆盖，改路径不用重新部署。
 * ────────────────────────────────────────────────────────────────────
 *
 * 路径覆盖示例：
 *   GMGN_PATH_DAILY_PROFITS=/pf/api/v1/wallets/sol/daily_profits
 *
 * 另外一个未实现但常被需要的接口（钱包汇总 stats）在官方 openapi 上
 * 没有可靠路径，暂不提供——不要凭猜测加，端点猜错会静默返回 404 HTML。
 */

import { randomUUID } from 'crypto';

// ─── Env ───────────────────────────────────────────────────────────────────────

const API_KEY = process.env.GMGN_API_KEY ?? '';
const HOST = process.env.GMGN_API_HOST ?? 'https://openapi.gmgn.ai';

const PATHS = {
  /** verified —— 批量钱包盈利 */
  walletProfits: process.env.GMGN_PATH_WALLET_PROFITS ?? '/v1/user/wallet_profits',
  /** unverified —— 单钱包按天明细，路径待线上确认 */
  dailyProfits:
    process.env.GMGN_PATH_DAILY_PROFITS ?? '/v1/wallets/{chain}/daily_profits',
} as const;

/** 单批地址数上限，官方未明示，保守取 20 */
const DEFAULT_CHUNK = 20;

// ─── Types ──────────────────────────────────────────────────────────────────────

export interface GmgnResponse<T> {
  code: number;
  reason?: string;
  message?: string;
  data: T;
}

export interface DailyProfit {
  date: number;
  total_profit: string;
  total_buys: number;
  total_sells: number;
  total_transfer_ins: number;
  total_transfer_outs: number;
  buy_amount_usd: string;
  sell_amount_usd: string;
  transfer_in_amount_usd: string;
  transfer_out_amount_usd: string;
  win_sells: number;
  loss_sells: number;
  win_profit: string;
  loss_profit: string;
}

export interface DailyProfitsResponse {
  list: DailyProfit[];
}

/** wallet_profits 返回的字段未经真实响应校验，故不写死形状 */
export type WalletProfit = Record<string, unknown>;

export class GmgnError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'GmgnError';
  }
}

// ─── Core fetch ─────────────────────────────────────────────────────────────────

async function gmgnFetch<T>(
  method: 'GET' | 'POST',
  subPath: string,
  options: { query?: Record<string, string | number>; body?: unknown } = {},
): Promise<GmgnResponse<T>> {
  if (!API_KEY) {
    throw new GmgnError('GMGN_API_KEY 未配置');
  }

  const { query = {}, body } = options;
  const params = new URLSearchParams({
    timestamp: String(Math.floor(Date.now() / 1000)),
    client_id: randomUUID(),
    ...query,
  });

  const url = `${HOST}${subPath}?${params}`;

  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: {
        'X-APIKEY': API_KEY,
        'Content-Type': 'application/json',
        'User-Agent': 'solwallet/1.0',
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  } catch (err: any) {
    // 连接层失败几乎总是网络问题：国内直连 openapi.gmgn.ai 会超时。
    throw new GmgnError(
      `无法连接 GMGN (${err?.cause?.code ?? err?.message ?? 'unknown'})：` +
        '本机/本地开发环境直连 GMGN 不通，需经 Vercel 或海外服务器中转。',
    );
  }

  const text = await res.text();

  if (!res.ok) {
    // 404 常见于路径写错（不是 key 问题）——单独提示，避免误判成鉴权失败。
    throw new GmgnError(
      res.status === 404
        ? `GMGN 路径不存在 (404) ${subPath}——请确认该端点是否属于 openapi 主机`
        : `GMGN HTTP ${res.status}: ${text.slice(0, 300)}`,
      res.status,
    );
  }

  let json: GmgnResponse<T>;
  try {
    json = JSON.parse(text) as GmgnResponse<T>;
  } catch {
    throw new GmgnError(`GMGN 返回非 JSON: ${text.slice(0, 200)}`, res.status);
  }

  if (json.code !== 0) {
    throw new GmgnError(`GMGN code=${json.code}: ${json.message ?? json.reason}`, res.status);
  }

  return json;
}

// ─── Public API ─────────────────────────────────────────────────────────────────

/**
 * POST /v1/user/wallet_profits —— 批量钱包盈利（30d / 7d / 24h）。
 *
 * 单批上限：保守取 20（官方未明示，留余量）。
 */
export async function getWalletProfits(
  chain: string,
  period: '30d' | '7d' | '24h',
  walletAddresses: string[],
  opts: { chunkSize?: number } = {},
): Promise<WalletProfit[]> {
  const addrs = [...new Set(walletAddresses)].filter(Boolean);
  if (!addrs.length) return [];

  const chunkSize = opts.chunkSize ?? DEFAULT_CHUNK;
  const out: WalletProfit[] = [];

  for (let i = 0; i < addrs.length; i += chunkSize) {
    const chunk = addrs.slice(i, i + chunkSize);
    const resp = await gmgnFetch<WalletProfit[]>('POST', PATHS.walletProfits, {
      query: { chain },
      body: { chain, period, wallet_addresses: chunk },
    });
    if (Array.isArray(resp.data)) out.push(...resp.data);
  }

  return out;
}

/**
 * GET 单钱包按天明细。
 *
 * ⚠ 路径未验证。首次线上调用若 404，用 GMGN_PATH_DAILY_PROFITS 覆盖即可。
 */
export async function getDailyProfits(
  chain: string,
  address: string,
  days = 30,
): Promise<DailyProfit[]> {
  const path = PATHS.dailyProfits.replace('{chain}', chain);
  const resp = await gmgnFetch<DailyProfitsResponse>('GET', path, {
    query: { address, period: `${days}d` },
  });
  return resp.data?.list ?? [];
}