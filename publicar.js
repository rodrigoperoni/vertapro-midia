// Publicador automático do VertaPro no Instagram (API do Instagram com login do Instagram). Roda no GitHub Actions a cada 15 minutos
// (ver .github/workflows/publicar.yml) ou à mão. Lê agenda.json, publica o que já passou da hora e ainda não saiu (publicado.json) e
// grava o resultado em publicado.json. O Facebook (Página) recebe por publicação DIRETA pela API da Meta (FB_PAGE_TOKEN e FB_PAGE_ID); cada rede é
// controlada à parte em publicado.json (idInstagram, idFacebook): se uma falhar, a outra não é repetida e a que falhou tenta de novo na próxima rodada.
// Variáveis: IG_TOKEN (segredo), IG_USER_ID, BASE_MIDIA (padrão: endereço raw do repositório), JANELA_HORAS (padrão 36: não publica nada mais velho que isso).
// Uso: node publicar.js [--teste]  (--teste: só mostra o que publicaria, não envia nada)  |  node publicar.js --so=<id>  (publica só esse item, ignorando o horário)
const fs = require('fs');
const path = require('path');
const { avisar } = require('./aviso');
const VERSAO = 'v21.0';
const BASE_API = `https://graph.instagram.com/${VERSAO}`;
const TOKEN = process.env.IG_TOKEN || '';
const USER = process.env.IG_USER_ID || '';
const BASE_FB = `https://graph.facebook.com/${VERSAO}`;
const FB_TOKEN = process.env.FB_PAGE_TOKEN || '';
const FB_PAGE = process.env.FB_PAGE_ID || '';
// Endereço das imagens segue o repositório onde o Actions roda (GITHUB_REPOSITORY), para continuar certo se o repositório mudar de dono.
const BASE_MIDIA = process.env.BASE_MIDIA || `https://raw.githubusercontent.com/${process.env.GITHUB_REPOSITORY || 'rodrigoperoni/vertapro-midia'}/main/midia`;
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

// Espera o contêiner (imagem, vídeo ou carrossel) ficar pronto: até ~5 min.
async function esperarContainer(id) {
    let status = 'IN_PROGRESS';
    for (let i = 0; i < 30 && status === 'IN_PROGRESS'; i++) {
        await esperar(i === 0 ? 3000 : 10000);
        status = (await api('GET', id, { fields: 'status_code' })).status_code;
    }
    if (status !== 'FINISHED') throw new Error(`contêiner ${id} terminou em ${status}`);
}

// Carrossel (2 a 10 imagens, item.arquivos): um contêiner por imagem, depois o contêiner do carrossel com a legenda. seco = true: pára antes de publicar (teste).
async function publicarCarrossel(item, { seco = false } = {}) {
    if (!Array.isArray(item.arquivos) || item.arquivos.length < 2 || item.arquivos.length > 10) throw new Error('carrossel precisa de 2 a 10 imagens em "arquivos"');
    const filhos = [];
    for (const arq of item.arquivos) filhos.push((await api('POST', `${USER}/media`, { image_url: url(arq), is_carousel_item: 'true' })).id);
    for (const id of filhos) await esperarContainer(id);
    const carrossel = await api('POST', `${USER}/media`, { media_type: 'CAROUSEL', children: filhos.join(','), caption: item.legenda });
    await esperarContainer(carrossel.id);
    if (seco) return carrossel.id;
    return (await api('POST', `${USER}/media_publish`, { creation_id: carrossel.id })).id;
}

async function publicar(item) {
    if (item.tipo === 'carrossel') return publicarCarrossel(item);
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

// ---------- Facebook (Página) ----------
async function fb(metodo, caminho, params = {}) {
    const u = `${BASE_FB}/${caminho}`;
    const corpo = new URLSearchParams({ ...params, access_token: FB_TOKEN });
    const r = await fetch(metodo === 'GET' ? `${u}?${corpo}` : u, { method: metodo, body: metodo === 'GET' ? undefined : corpo });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.error) throw new Error(`FB ${r.status} ${j.error ? j.error.message : JSON.stringify(j)}`.slice(0, 400));
    return j;
}

// Vídeo hospedado (Reels e stories da Página): começa, manda o endereço do arquivo (a Meta baixa), espera e termina.
async function videoEmFases(tipo, item, extrasDoFim) {
    const inicio = await fb('POST', `${FB_PAGE}/${tipo}`, { upload_phase: 'start' });
    const envio = await fetch(inicio.upload_url, { method: 'POST', headers: { Authorization: `OAuth ${FB_TOKEN}`, file_url: url(item.arquivo) } });
    const resp = await envio.json().catch(() => ({}));
    if (!envio.ok || resp.success === false) throw new Error(`FB envio do vídeo: ${envio.status} ${JSON.stringify(resp)}`.slice(0, 300));
    for (let i = 0; i < 30; i++) { // até ~5 min
        await esperar(10000);
        const st = (await fb('GET', inicio.video_id, { fields: 'status' })).status || {};
        const fase = (st.uploading_phase || {}).status;
        if (fase === 'complete' || st.video_status === 'ready') break;
        if (fase === 'error' || st.video_status === 'error') throw new Error(`FB vídeo com erro: ${JSON.stringify(st)}`.slice(0, 300));
    }
    const fim = await fb('POST', `${FB_PAGE}/${tipo}`, { upload_phase: 'finish', video_id: inicio.video_id, ...extrasDoFim });
    return fim.post_id || fim.id || inicio.video_id;
}

// Várias fotos numa publicação da Página: cada foto sobe sem publicar e depois o post anexa todas. seco = true: cria o post como NÃO publicado (teste).
async function publicarCarrosselNoFacebook(item, { seco = false } = {}) {
    const ids = [];
    for (const arq of item.arquivos) ids.push((await fb('POST', `${FB_PAGE}/photos`, { url: url(arq), published: 'false' })).id);
    const params = { message: item.legenda };
    if (seco) params.published = 'false';
    ids.forEach((id, i) => { params[`attached_media[${i}]`] = JSON.stringify({ media_fbid: id }); });
    return (await fb('POST', `${FB_PAGE}/feed`, params)).id;
}

async function publicarNoFacebook(item) {
    if (item.tipo === 'carrossel') return publicarCarrosselNoFacebook(item);
    const ehVideo = /\.mp4$/i.test(item.arquivo);
    if (item.tipo === 'reel') return videoEmFases('video_reels', item, { video_state: 'PUBLISHED', description: item.legenda });
    if (item.tipo === 'story') {
        if (ehVideo) return videoEmFases('video_stories', item, {});
        const foto = await fb('POST', `${FB_PAGE}/photos`, { url: url(item.arquivo), published: 'false' });
        const st = await fb('POST', `${FB_PAGE}/photo_stories`, { photo_id: foto.id });
        return st.post_id || st.id || foto.id;
    }
    if (ehVideo) return (await fb('POST', `${FB_PAGE}/videos`, { file_url: url(item.arquivo), description: item.legenda })).id;
    const f = await fb('POST', `${FB_PAGE}/photos`, { url: url(item.arquivo), caption: item.legenda });
    return f.post_id || f.id;
}

// ---------- Tentativas e avisos ----------
const ESPERAS_MIN = [10, 60, 180]; // depois da 1ª, 2ª e 3ª falha; na 4ª desiste
const PAUSA_SPAM_MIN = 180;
// Com post do Facebook atrasado, sai no máximo 1 a cada 90 min (para não despejar a fila de uma vez e levar nova recusa). Não é um limite informado pela Meta. O Instagram não muda.
const ESPACO_FB_MIN = 90;
const ATRASADO_MIN = 15;
const NOMES = { instagram: 'Instagram', facebook: 'Facebook' };
const arquivosDe = (i) => (i.arquivos || [i.arquivo]).filter(Boolean);

function podeTentar(tent, id, rede, agora) {
    if (SO) return true;
    const pausa = tent[`_pausa_${rede}`];
    if (pausa && agora < Date.parse(pausa)) return false;
    const t = tent[`${id}|${rede}`];
    return !t || (t.tentativas <= ESPERAS_MIN.length && agora >= Date.parse(t.proxima));
}

function facebookPodeSair(tent, temAtrasado, agora) {
    if (SO || !temAtrasado) return true;
    const ultima = Date.parse(tent._ultima_tentativa_facebook || '');
    return !ultima || agora - ultima >= ESPACO_FB_MIN * 60000;
}

async function anotarFalha(tent, item, rede, erro) {
    const chave = `${item.id}|${rede}`;
    const t = tent[chave] || { tentativas: 0 };
    t.tentativas++;
    t.erro = String(erro).slice(0, 300);
    const espera = ESPERAS_MIN[t.tentativas - 1];
    t.proxima = new Date(Date.now() + (espera || 0) * 60000).toISOString();
    tent[chave] = t;
    if (/limitamos|limit|spam|too many|frequ/i.test(t.erro)) tent[`_pausa_${rede}`] = new Date(Date.now() + PAUSA_SPAM_MIN * 60000).toISOString();
    if (t.tentativas === 1) await avisar(`Falha ao publicar no ${NOMES[rede]}: ${item.id}`, `Erro: ${t.erro}\n\nVou tentar de novo mais tarde (no máximo 4 vezes).`);
    if (!espera) await avisar(`DESISTI de publicar no ${NOMES[rede]}: ${item.id}`, `Falhou ${t.tentativas} vezes. Não vou tentar de novo sozinho.\n\nÚltimo erro: ${t.erro}`);
}

// Avisa ANTES de quebrar: item dos próximos 3 dias sem o arquivo na pasta midia/.
async function conferirProximasMidias(agenda, feito, agora) {
    const faltam = agenda.filter((i) => !(feito[i.id] || {}).idInstagram && Date.parse(i.quando) > agora && Date.parse(i.quando) - agora <= 72 * 3600e3)
        .filter((i) => arquivosDe(i).some((a) => !fs.existsSync(aqui(path.join('midia', a)))));
    if (faltam.length) await avisar('Faltam arquivos para postagens dos próximos 3 dias', faltam.map((i) => `- ${i.quando} ${i.id}`).join('\n'));
    return faltam.length;
}

async function principal() {
    const agenda = lerJson('agenda.json', []);
    const feito = lerJson('publicado.json', {});
    const agora = Date.now();
    const usaFacebook = !!(FB_TOKEN && FB_PAGE);
    const falta = (i) => { const r = feito[i.id] || {}; return { instagram: !r.idInstagram, facebook: usaFacebook && !r.idFacebook }; };
    const devidos = agenda.filter((i) => {
        const f = falta(i);
        if (!f.instagram && !f.facebook) return false;
        return SO ? i.id === SO : (Date.parse(i.quando) <= agora && agora - Date.parse(i.quando) <= JANELA_MS);
    });
    console.log(`Agora: ${new Date(agora).toISOString()} | agenda: ${agenda.length} | Instagram+Facebook: ${usaFacebook ? 'sim' : 'só Instagram'} | para publicar agora: ${devidos.length}`);
    if (SO && !devidos.length) { console.log('Nenhum item com esse id (ou já publicado em tudo).'); return; }
    if (TESTE) { devidos.forEach((i) => { const f = falta(i); console.log('SERIA PUBLICADO:', i.id, i.tipo, `[${[f.instagram && 'Instagram', f.facebook && 'Facebook'].filter(Boolean).join(' + ')}]`, url(i.arquivo)); }); return; }
    if (devidos.length && (!TOKEN || !USER)) { console.log('ERRO: faltam IG_TOKEN e/ou IG_USER_ID.'); process.exit(1); }
    if (!SO) await conferirProximasMidias(agenda, feito, agora);
    const tent = lerJson('falhas.json', {});
    const gravarTent = () => fs.writeFileSync(aqui('falhas.json'), JSON.stringify(tent, null, 2));
    let falhas = 0;
    const gravar = () => fs.writeFileSync(aqui('publicado.json'), JSON.stringify(feito, null, 2));
    const temAtrasadoNoFacebook = devidos.some((i) => falta(i).facebook && podeTentar(tent, i.id, 'facebook', agora) && agora - Date.parse(i.quando) > ATRASADO_MIN * 60000);
    for (const item of devidos) {
        const f = falta(item);
        const reg = feito[item.id] || {};
        if (f.instagram && podeTentar(tent, item.id, 'instagram', Date.now())) {
            try { reg.idInstagram = await publicar(item); reg.publicadoEm = reg.publicadoEm || new Date().toISOString(); feito[item.id] = reg; gravar(); console.log('PUBLICADO no Instagram', item.id, reg.idInstagram); }
            catch (e) { falhas++; console.log('FALHOU no Instagram', item.id, '-', e.message); await anotarFalha(tent, item, 'instagram', e.message); gravarTent(); }
        }
        if (f.facebook && podeTentar(tent, item.id, 'facebook', Date.now()) && facebookPodeSair(tent, temAtrasadoNoFacebook, Date.now())) {
            tent._ultima_tentativa_facebook = new Date(Date.now()).toISOString(); gravarTent(); // fica em falhas.json, que a automação salva no GitHub: vale também para a próxima rodada
            try { reg.idFacebook = String(await publicarNoFacebook(item)); reg.publicadoEm = reg.publicadoEm || new Date().toISOString(); feito[item.id] = reg; gravar(); console.log('PUBLICADO no Facebook', item.id, reg.idFacebook); }
            catch (e) { falhas++; console.log('FALHOU no Facebook', item.id, '-', e.message); await anotarFalha(tent, item, 'facebook', e.message); gravarTent(); }
        }
    }
    if (falhas) process.exit(1);
}
if (require.main === module) principal();
module.exports = { principal, facebookPodeSair, podeTentar, anotarFalha, conferirProximasMidias, publicarCarrossel, publicarCarrosselNoFacebook, fb, api };
