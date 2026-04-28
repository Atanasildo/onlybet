# 🚀 Only Bet — Guia de Deploy no Vercel
**Tempo estimado: 10-15 minutos**

---

## 📁 Estrutura do Projecto

```
onlybet-vercel/
├── index.html          ← Frontend completo
├── vercel.json         ← Configuração Vercel
├── package.json        ← Dependências
└── api/
    ├── odds.js         ← Proxy The Odds API (resolve CORS)
    ├── football.js     ← Proxy API-Football (resolve CORS)
    └── deposito.js     ← Gestão de pedidos de depósito
```

---

## PASSO 1 — Criar conta no Vercel

1. Vai a **vercel.com**
2. Clica em **"Sign Up"**
3. Regista com **GitHub** (recomendado) ou email
4. Confirma o email se pedido

---

## PASSO 2 — Criar conta no GitHub (se não tens)

O Vercel funciona melhor com GitHub. Se não tens:

1. Vai a **github.com**
2. Clica **"Sign up"**
3. Cria conta gratuita

---

## PASSO 3 — Fazer upload do projecto para GitHub

### Opção A — GitHub Desktop (mais fácil, sem código)
1. Descarrega **GitHub Desktop** em desktop.github.com
2. Instala e faz login
3. Clica **"Create New Repository"**
4. Nome: `onlybet`
5. Clica **"Publish Repository"** (público ou privado)
6. Arrasta os ficheiros do projecto para a pasta criada
7. Clica **"Commit to main"** → **"Push origin"**

### Opção B — Terminal (mais rápido)
```bash
cd onlybet-vercel
git init
git add .
git commit -m "Only Bet - Versão inicial"
git branch -M main
git remote add origin https://github.com/TEU_USERNAME/onlybet.git
git push -u origin main
```

---

## PASSO 4 — Conectar ao Vercel

1. Vai ao **Vercel Dashboard** (vercel.com/dashboard)
2. Clica **"Add New Project"**
3. Clica **"Import Git Repository"**
4. Seleciona o repositório **onlybet**
5. Em **Framework Preset** seleciona **"Other"**
6. Em **Root Directory** deixa como está (raiz)
7. Clica **"Deploy"**

⏳ Aguarda 1-2 minutos...

---

## PASSO 5 — Verificar o Deploy

Após o deploy:
1. O Vercel dá-te um URL como: `https://onlybet-xxxxx.vercel.app`
2. Abre o URL no browser
3. Deves ver o Only Bet a funcionar!
4. Os jogos ao vivo e apostas desportivas devem aparecer com dados reais

---

## PASSO 6 — Domínio Personalizado (Opcional)

Para usar `www.onlybet.ao` em vez do URL do Vercel:

1. No Vercel Dashboard → clica no projecto
2. Vai a **Settings** → **Domains**
3. Adiciona o teu domínio: `onlybet.ao`
4. O Vercel mostra os DNS a configurar
5. Vai ao teu registador de domínio e configura os DNS indicados
6. Aguarda até 48h para propagar

---

## ⚙️ Configurar os Teus Números de Pagamento

Antes do deploy, edita o ficheiro `api/deposito.js` e substitui pelos teus números reais:

```javascript
const contas = {
  unitel: 'SEU_NUMERO_UNITEL_MONEY',  // ex: 923 456 789
  paypay: 'SEU_NUMERO_PAYPAY'         // ex: 924 567 890
};
```

E no `index.html` procura por:
```javascript
const UNITEL_NUM = '923 456 789';
const PAYPAY_NUM = '924 567 890';
```
Substitui pelos teus números reais.

---

## 🔄 Como Actualizar o Site

Sempre que fizeres mudanças:

```bash
git add .
git commit -m "Descrição da mudança"
git push
```

O Vercel faz o deploy automaticamente em 1-2 minutos!

---

## ❓ Problemas Comuns

**Os jogos ao vivo não aparecem:**
- Verifica se o deploy foi bem sucedido no Vercel
- Abre a consola do browser (F12) e verifica erros
- A API-Football tem 100 req/dia no plano grátis — pode ter esgotado

**Erro 404 nas APIs:**
- Verifica que a pasta `api/` está na raiz do projecto
- Verifica o `vercel.json`

**O site não carrega:**
- Verifica que o `index.html` está na raiz (não numa pasta)

---

## 📞 Suporte

Se tiveres problemas, volta aqui e descreve o erro — ajudo-te a resolver!

---

*Only Bet © 2025 — Guia Técnico Confidencial*
