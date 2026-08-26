'use strict';

const path = require('path');
const fs = require('fs');
const express = require('express');
const session = require('express-session');

const app = express();
const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

// --- Dados em memoria (resetam a cada restart) ---------------------------

const usuarios = [
  { username: 'ana', password: '123456' },
];

const itensSemente = [
  'Comprar cafe',
  'Revisar relatorio semanal',
  'Agendar reuniao de alinhamento',
  'Atualizar documentacao do projeto',
];

// --- Helpers ---------------------------------------------------------------

// Escapa texto fornecido pelo usuario antes de reinjeta-lo em HTML/atributos,
// para evitar XSS refletido trivial (ex.: nome de usuario ecoado na tela).
function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Renderizacao simples por substituicao de placeholders {{CHAVE}} -- sem
// motor de template (nao previsto na spec), apenas string replace.
//
// Substituicao em passe unico via regex: o replace do String.prototype
// resolve todos os matches contra o HTML ORIGINAL antes de montar a string
// final, entao um valor inserido para uma chave nunca e re-escaneado em
// busca de outras chaves. Isso evita que texto controlado pelo usuario
// (ex.: um username literalmente igual a "{{ITEMS}}") acabe sendo
// re-substituido por engano por um placeholder posterior.
const PLACEHOLDER_RE = /\{\{(\w+)\}\}/g;

function renderTemplate(fileName, replacements) {
  const filePath = path.join(PUBLIC_DIR, fileName);
  const html = fs.readFileSync(filePath, 'utf8');
  return html.replace(PLACEHOLDER_RE, (match, key) => (
    Object.prototype.hasOwnProperty.call(replacements, key) ? replacements[key] : match
  ));
}

function renderLogin({ errorText = '', successText = '', usernameValue = '' } = {}) {
  return renderTemplate('login.html', {
    ERROR_TEXT: escapeHtml(errorText),
    SUCCESS_TEXT: escapeHtml(successText),
    USERNAME_VALUE: escapeHtml(usernameValue),
  });
}

function renderCadastro({ errorText = '', usernameValue = '' } = {}) {
  return renderTemplate('cadastro.html', {
    ERROR_TEXT: escapeHtml(errorText),
    USERNAME_VALUE: escapeHtml(usernameValue),
  });
}

function renderListagem({ username }) {
  const itemsHtml = itensSemente
    .map((item) => `<li>${escapeHtml(item)}</li>`)
    .join('\n    ');
  return renderTemplate('listagem.html', {
    USERNAME: escapeHtml(username),
    ITEMS: itemsHtml,
  });
}

// --- Middleware --------------------------------------------------------

app.use(express.urlencoded({ extended: false }));

// Sessao em memoria (MemoryStore padrao do express-session). O aviso do
// MemoryStore sobre uso em producao e esperado: dados em memoria sao um
// requisito da spec (fixture de teste), nao um bug a corrigir. O `secret`
// abaixo e fixo e intencionalmente nao-seguro -- app de teste, nao produto.
app.use(session({
  secret: 'dev-secret-nao-usar-em-producao-fixture-de-teste',
  resave: false,
  saveUninitialized: false,
}));

// --- Rotas: Login --------------------------------------------------------

app.get('/login', (req, res) => {
  const cadastroOk = req.query.cadastro === '1';
  res.send(renderLogin({
    successText: cadastroOk ? 'Cadastro realizado com sucesso. Faca login.' : '',
  }));
});

app.post('/login', (req, res) => {
  const { username, password } = req.body || {};
  const usuario = usuarios.find(
    (u) => u.username === username && u.password === password,
  );

  if (!usuario) {
    res.status(401).send(renderLogin({
      errorText: 'usuario ou senha invalidos',
      usernameValue: username,
    }));
    return;
  }

  req.session.username = usuario.username;
  res.redirect('/listagem');
});

// --- Rotas: Cadastro -----------------------------------------------------

app.get('/cadastro', (req, res) => {
  res.send(renderCadastro());
});

app.post('/cadastro', (req, res) => {
  const { username, password } = req.body || {};
  // Comparacao exata e case-sensitive ("Ana" !== "ana"), por decisao de design.
  const jaExiste = usuarios.some((u) => u.username === username);

  if (jaExiste) {
    res.status(409).send(renderCadastro({
      errorText: 'usuario ja existe',
      usernameValue: username,
    }));
    return;
  }

  usuarios.push({ username, password });
  res.redirect('/login?cadastro=1');
});

// --- Rotas: Listagem -------------------------------------------------------

app.get('/listagem', (req, res) => {
  if (!req.session || !req.session.username) {
    res.redirect('/login');
    return;
  }

  res.send(renderListagem({ username: req.session.username }));
});

// --- Start ---------------------------------------------------------------

app.listen(PORT, () => {
  console.log(`servidor rodando em http://localhost:${PORT}`);
});

module.exports = app;
