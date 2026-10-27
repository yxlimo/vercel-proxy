const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const vercelJson = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'vercel.json'), 'utf8')
);

const rewrites = vercelJson.rewrites || [];

/**
 * 把 rewrite 的 source 模式编译成正则，用来模拟 Vercel 的路径匹配。
 *
 * 只支持本仓库实际用到的语法：
 *   :name     匹配一段
 *   :name*    匹配零段或多段
 */
function sourceToRegex(source) {
    const escape = (text) => text.replace(/[.+?^${}()|[\]\\]/g, '\\$&');

    const parts = [];
    let cursor = 0;
    // 通配参数连同它前面的斜杠一起吸收：
    // /:path* 匹配零段或多段，/:path 恰好匹配一段。
    const paramPattern = /\/?:([A-Za-z_][A-Za-z0-9_]*)(\*)?/g;
    let match;
    while ((match = paramPattern.exec(source)) !== null) {
        parts.push(escape(source.slice(cursor, match.index)));
        parts.push(match[2] ? '(?:/(.*))?' : '/([^/]+)');
        cursor = match.index + match[0].length;
    }
    parts.push(escape(source.slice(cursor)));

    return new RegExp('^' + parts.join('') + '$');
}

/**
 * 找到第一条匹配该路径的 rewrite。
 *
 * Vercel 按数组顺序求值，第一条命中的生效——顺序错了就会被后面的兜底规则吞掉。
 */
function matchRewrite(pathname) {
    for (const rule of rewrites) {
        const regex = sourceToRegex(rule.source);
        const match = regex.exec(pathname);
        if (match) {
            const params = match.slice(1);
            return {
                rule,
                destination: rule.destination.replace(/:([A-Za-z_][A-Za-z0-9_]*)(\*)?/g, (_, name, star) => {
                    const value = params.shift() || '';
                    return star ? value : value;
                })
            };
        }
    }
    return null;
}

const SHA256 = 'a'.repeat(64);

test('pi.dev 的 revision 路由命中外部上游', () => {
    const matched = matchRewrite(`/pi/api/models/revisions/sha256-${SHA256}`);
    assert.ok(matched, '应当命中某条 rewrite');
    assert.equal(matched.rule.destination, 'https://pi.dev/api/models/revisions/:path*');
    assert.equal(
        matched.destination,
        `https://pi.dev/api/models/revisions/sha256-${SHA256}`
    );
});

test('pi.dev 路由排在 TMDB 兜底路由之前', () => {
    const piIndex = rewrites.findIndex((r) => r.source.startsWith('/pi/'));
    const fallbackIndex = rewrites.findIndex((r) => r.source === '/:path*');
    assert.ok(piIndex >= 0, '应当存在 pi 路由');
    assert.ok(fallbackIndex >= 0, '应当存在 TMDB 兜底路由');
    assert.ok(piIndex < fallbackIndex, 'pi 路由必须在兜底路由之前，否则会被吞掉');
});

test('TMDB 路由未被 pi 路由影响', () => {
    assert.equal(
        matchRewrite('/3/movie/550').destination,
        '/api/tmdb.js'
    );
    assert.equal(
        matchRewrite('/t/p/w500/poster.jpg').destination,
        'https://image.tmdb.org/t/p/w500/poster.jpg'
    );
});

test('pi 路由不会劫持 TMDB 的图片与接口路径', () => {
    for (const p of ['/3/movie/550', '/4/movie/550', '/t/w780/poster.jpg', '/health']) {
        const matched = matchRewrite(p);
        assert.ok(matched, `${p} 应当命中 rewrite`);
        assert.ok(
            !matched.rule.destination.includes('pi.dev'),
            `${p} 不该被转到 pi.dev，实际转到 ${matched.rule.destination}`
        );
    }
});

test('pi 路由只覆盖 revisions 前缀，不会成为开放代理', () => {
    const matched = matchRewrite('/pi/api/models/revisions/sha256-abc');
    assert.ok(matched);
    assert.ok(matched.rule.destination.includes('pi.dev/api/models/revisions/'));

    // 上游其它路径不应被这条规则匹配到
    for (const p of ['/pi/etc/passwd', '/pi/api/other', '/pi']) {
        const m = matchRewrite(p);
        assert.ok(
            !m || !m.rule.destination.includes('pi.dev'),
            `${p} 不该被转到 pi.dev`
        );
    }
});
