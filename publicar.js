// Publicador automático do VertaPro no Instagram (API do Instagram com login do Instagram). Roda no GitHub Actions a cada 15 minutos
// (ver .github/workflows/publicar.yml) ou à mão. Lê agenda.json, publica o que já passou da hora e ainda não saiu (publicado.json) e
// grava o resultado em publicado.json. O Facebook recebe pelo compartilhamento automático ligado no próprio Instagram.
// Variáveis: IG_TOKEN (segredo), IG_USER_ID, BASE_MIDIA (padrão: endereço raw do repositório), JANELA_HORAS (padrão 36: não publica nada mais velho que isso).
// Uso: node publicar.js [--teste]  (--teste: só mostra o que publicaria, não envia nada)  |  node publicar.js --so=<id>  (publica só esse item, ignorando o horário)
const fs = require('fs');
const path = require('path');
const VERSAO = 'v21.0';
const BASE_API = `https://graph.instagram.com/${VERSAO}`;
const TOKEN = process.env.IG_TOKEN || '';
const USER = process.env.IG_USER_ID || '';
const BASE_MIDIA = process.env.BASE_MIDIA || 'https://raw.githubusercontent.com/rodrigoperoni/vertapro-midia/main/midia';
const JANELA_MS = Number(process.env.JANELA_HORAS || 36) * 3600e3;
const SO = (process.argv.find((a) => a.startsWith('--so=')) || '').split('=')[1];
const TESTE = process.argv.includes('--teste');
const aqui = (f) => path.join(__dirname, f);
const lerJson = (f, padrao) => { try { return JSON.parse(fs.readFileSync(aqui(f), 'utf8')); } catch { return padrao; } };
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
const url = (arquivo) => `${BASE_MIDIA}/${encodeURIComponent(arquivo)}`;

async function api(metodo, caminho, params = {}) {
    const u = new URL(`${BASE_API}/${caminho}`);
    const corpo = new URLSearchParams({ ...params, access_token: TOKEN });
    const r = await fetch(metodo === 'GET' ? `${u}?${corpo}` : u, { method: metodo, body: metodo === 'GET' ? undefined : corpo });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.error) throw new Error(`${r.status} ${j.error ? j.error.message : JSON.stringify(j)}`.slice(0, 400));
    return j;
}

function paramsDoItem(item) {
    const midia = url(item.arquivo);
    if (item.tipo === 'reel') return { media_type: 'REELS', video_url: midia, caption: item.legenda, share_to_feed: 'true' };
    if (item.tipo === 'story') return /\.mp4$/i.test(item.arquivo) ? { media_type: 'STORIES', video_url: midia } : { media_type: 'STORIES', image_url: midia };
    return { image_url: midia, caption: item.legenda };
}

async function publicar(item) {
    const container = await api('POST', `${USER}/media`, paramsDoItem(item));
    let status = 'IN_PROGRESS';
    for (let i = 0; i < 30 && status === 'IN_PROGRESS'; i++) { // até ~5 min (vídeos demoram mais)
        await esperar(10000);
        status = (await api('GET', container.id, { fields: 'status_code' })).status_code;
    }
    if (status !== 'FINISHED') throw new Error(`contêiner ${container.id} terminou em ${status}`);
    const saiu = await api('POST', `${USER}/media_publish`, { creation_id: container.id });
    return saiu.id;
}

(async () => {
    const agenda = lerJson('agenda.json', []);
    const feito = lerJson('publicado.json', {});
    const agora = Date.now();
    const devidos = agenda.filter((i) => !feito[i.id] && (SO ? i.id === SO : (Date.parse(i.quando) <= agora && agora - Date.parse(i.quando) <= JANELA_MS)));
    console.log(`Agora: ${new Date(agora).toISOString()} | agenda: ${agenda.length} | já publicados: ${Object.keys(feito).length} | para publicar agora: ${devidos.length}`);
    if (SO && !devidos.length) { console.log('Nenhum item com esse id (ou já publicado).'); return; }
    if (TESTE) { devidos.forEach((i) => console.log('SERIA PUBLICADO:', i.id, i.tipo, url(i.arquivo))); return; }
    if (devidos.length && (!TOKEN || !USER)) { console.log('ERRO: faltam IG_TOKEN e/ou IG_USER_ID.'); process.exit(1); }
    let falhas = 0;
    for (const item of devidos) {
        try {
            const id = await publicar(item);
            feito[item.id] = { publicadoEm: new Date().toISOString(), idInstagram: id };
            fs.writeFileSync(aqui('publicado.json'), JSON.stringify(feito, null, 2));
            console.log('PUBLICADO', item.id, id);
        } catch (e) { falhas++; console.log('FALHOU', item.id, '-', e.message); }
    }
    if (falhas) process.exit(1);
})();
