// Aviso ao dono: abre um alerta (issue) no GitHub marcando o dono, que recebe a notificação/e-mail. Um alerta aberto por título (não repete).
// Atenção: o repositório é público; nunca incluir chave ou token no texto.
const DONO = (process.env.GITHUB_REPOSITORY || 'rodrigoperoni/vertapro-midia').split('/')[0];
const limpar = (t) => String(t).replace(/(access_token=|OAuth\s+|Bearer\s+)[^\s&"']+/gi, '$1***').replace(/\b(EAA|IG[QA])[A-Za-z0-9_-]{20,}/g, '***');

async function avisar(titulo, texto) {
    const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
    const repo = process.env.GITHUB_REPOSITORY;
    if (!token || !repo) { console.log('AVISO (não enviado, fora do GitHub):', titulo); return false; }
    const cab = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'publicador' };
    try {
        const r = await fetch(`https://api.github.com/repos/${repo}/issues?state=open&per_page=100`, { headers: cab });
        const abertos = await r.json();
        if (Array.isArray(abertos) && abertos.some((i) => i.title === titulo)) return false;
        const n = await fetch(`https://api.github.com/repos/${repo}/issues`, { method: 'POST', headers: cab, body: JSON.stringify({ title: titulo, body: `@${DONO}\n\n${limpar(texto)}` }) });
        if (!n.ok) { console.log('AVISO FALHOU:', n.status, titulo); return false; }
        console.log('AVISO ENVIADO:', titulo);
        return true;
    } catch (e) { console.log('AVISO FALHOU:', e.message); return false; }
}
module.exports = { avisar };
if (require.main === module) avisar(process.argv[2] || 'Teste de aviso', process.argv[3] || 'Teste.').then(() => {});
