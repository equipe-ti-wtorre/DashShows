# Prompt: trocar o front do /siport pelo layout de referência

Copie a pasta `public/` deste pacote para a raiz do projeto do dashboard (mesclando com a
`public/` existente) e cole o texto abaixo no Cursor (Agent mode).

---

Substitua o front do módulo **/siport** pelo layout de referência que copiei para `public/`:

```
public/siport.html              página (5 abas: Monitoramento, Consulta, Alarmes, Leituras, Configuração)
public/siport.css               estilo completo (tema claro/escuro por prefers-color-scheme)
public/siport.js                lógica do front (JS puro, sem build)
public/siport-assets/fonts/     NuSansText Regular/Medium, NuSansDisplay Medium (.woff2)
public/siport-assets/logo-nubankparque-branco.svg
```

## Regras

1. **`siport.html` e `siport.css` entram como estão.** Não reescreva, não "melhore", não troque
   classes, cores nem estrutura. O objetivo é a tela ficar idêntica à de referência.
2. `siport.js` também deve ficar como está. **Quem se adapta é o backend**: faça as rotas
   `/api/siport/*` devolverem exatamente os formatos abaixo. Se for inevitável mexer no
   `siport.js`, altere só a camada de chamada (`api()` / `adminApi()`) e me diga o quê.
3. Garanta que o servidor sirva `/siport` → `public/siport.html` e os arquivos
   `/siport.css`, `/siport.js` e `/siport-assets/**` (com `Content-Type` de `.woff2` = `font/woff2`
   e `.svg` = `image/svg+xml`).
4. Os arquivos antigos do front do siport que forem substituídos podem ser removidos.
   Não mexa em nenhuma outra tela do dashboard.

## Convenções que o front espera

- Erro = **status HTTP ≠ 2xx** com corpo `{ "error": "mensagem" }` (campo `error`, não `erro`).
  - 400 validação, 401 senha de admin errada, 403 configuração bloqueada pela rede,
    503 backend sem dados/banco não configurado (a mensagem aparece na tela; se contiver
    "configur" o front mostra um link para a aba Configuração), 502 falha no banco.
- Todas as rotas de dados recebem `?date=AAAA-MM-DD&inicio=HH:MM`.
- Datas são **texto local** `"AAAA-MM-DD HH:mm:ss"` (nunca ISO/UTC). `null` quando não houver.
- A senha de admin vem no header `X-Admin-Senha`.

## Contrato das rotas

### `GET /api/siport/config`
```json
{ "modo": "sql" | "demo", "refreshMs": 15000, "defaultDate": "2026-09-13",
  "viradaHora": 6, "horaInicio": "16:00", "local": "Nubank Parque", "erro": null }
```
`defaultDate`: hoje no modo banco; no modo demo, o dia com mais leituras no arquivo.

### `GET /api/siport/summary`
```json
{
  "janela": { "date": "2026-09-13", "inicio": "16:00", "ini": "2026-09-13 16:00:00", "fim": "2026-09-14 06:00:00" },
  "totais": { "emitidos": 36307, "lidos": 22578, "naoLidos": 13729, "leituras": 22639,
              "cartoesLidos": 22586, "alarmes": 1381, "ultimaLeitura": "2026-09-13 22:43:52" },
  "setores": [ { "setor": "PISTA", "total": 11378, "lidos": 6002 } ],
  "blocos": [ { "bloco": "PREMB", "leituras": 6761, "alarmes": 397,
                "catracas": [ { "catraca": "PREMB 1", "leituras": 48, "alarmes": 3, "ultima": "2026-09-13 21:40:02" } ] } ],
  "alarmesTipo": [ { "tipo": "Anti-passback (já dentro)", "n": 533 } ],
  "serie": { "passoMin": 5, "leituras": [[192, 50], [193, 32]], "alarmes": [[192, 4]] }
}
```
- `setores`: agrupados (`CAMAROTE nnn` → `CAMAROTES`, `LOUNGE …` → `LOUNGES`), ordenados por `total` desc.
- `blocos`: bloco = nome da catraca sem o número final; catracas ordenadas por nome (numérico);
  blocos por `leituras` desc. Catraca que só teve alarme entra com `leituras: 0, ultima: null`.
- `serie`: pares `[bucket, quantidade]`, bucket = `floor(minutos desde janela.ini / 5)`, ordenados.
- `alarmesTipo` ordenado por `n` desc. Nomes dos tipos:
  In/Out Control → `Anti-passback (já dentro)`, wrong access level → `Perfil sem acesso`,
  Not went through → `Não passou (giro)`, unknow → `Ingresso desconhecido`,
  obsolet → `Ingresso obsoleto`, double → `Acesso duplo bloqueado`, valid → `Fora da validade`
  (testar nessa ordem; senão, o texto depois de `": "`).

### `GET /api/siport/feed?limit=40`
```json
{ "leituras": [ LEITURA ], "alarmes": [ ALARME ] }
```
Mais recentes primeiro (`ORDER BY ID DESC`).

```json
LEITURA = { "id": 14888326, "dt": "2026-09-13 22:43:52", "catraca": "PISA 14", "codigo": "01023428171202",
            "setor": "PISTA", "info": "041036 01023428171202  PORTÃO A,PISTA", "versao": "10" }

ALARME  = { "id": 3972853, "dt": "2026-09-13 22:44:41", "catraca": "INFA 6", "codigo": "01156715112600",
            "texto": "01156715112600: wrong access level", "tipo": "Perfil sem acesso",
            "categoria": "PISTA PREMIUM ITAÚ PERSON",
            "primeiraLeitura": "2026-09-13 20:45:25", "ultimaLeitura": "2026-09-13 20:45:25" }
```
- `catraca` e `codigo` sem espaços nas pontas; `setor` = PersField5; `versao` = PersField1.
- `primeiraLeitura`/`ultimaLeitura`: MIN/MAX de `Uhrzeit` do mesmo cartão no ZLOG, na janela
  (`null` se nunca leu). `categoria`: `DATA_20_Name_NA` do ingresso (`null` fora da base).
  O front calcula com isso "entrou depois / já tinha entrado / não entrou".

### `GET /api/siport/alarms?catraca=&codigo=&limit=5000`
Array de `ALARME` (mesmo formato), mais recentes primeiro. `catraca`/`codigo` = LIKE `%x%`.

### `GET /api/siport/reads?catraca=&setor=&codigo=&limit=5000`
Array de `LEITURA`, mais recentes primeiro. Filtros LIKE `%x%`.

### `GET /api/siport/search?q=CODIGO`
```json
{
  "q": "01156715112600",
  "janela": { ...igual ao summary... },
  "ingressos": [ {
    "codigo": "01156715112600", "ident": "035144", "versao": "10",
    "validoDe": "2026-09-11 00:00:00", "validoAte": "2026-09-13 23:59:59",
    "perfis": ["FANZ", "G020"], "status": 0, "categoria": "PISTA PREMIUM ITAÚ PERSON",
    "portao": "PORTÃO B", "zona": 2, "tenant": 66,
    "setor": "PISTA PREMIUM", "codigoBarras": "501156715112694974273300",
    "freedefs": { "1": "267495", "2": "0", "3": "2026-09-11 15:29:29", "4": "PISTA PREMIUM", "5": "5011…" },
    "leituras": [ LEITURA ], "alarmes": [ ALARME ]
  } ],
  "avulsos": { "leituras": [ LEITURA ], "alarmes": [ ALARME ] }
}
```
- `perfis` = `GetStdProfiles` quebrado por vírgula. `status` = `PersStatus` cru. `zona` = `Room_RN`.
- `leituras`/`alarmes` de cada ingresso em ordem **cronológica crescente**, sem os filtros das views.
- `avulsos`: linhas de ZLOG/ALOG do código consultado quando ele não está na base.
- `q` com menos de 4 caracteres → 400.

### `GET /api/siport/settings`
```json
{
  "local": true, "temSenhaAdmin": false, "forceDemo": false, "temDemo": true,
  "modo": "sql", "refreshMs": 15000, "viradaHora": 6, "horaInicio": "16:00", "nomeLocal": "Nubank Parque",
  "db": { "server": "", "instanceName": "", "port": 1433, "database": "SIPORTNTACC",
          "autenticacao": "sql" | "windows", "user": "", "domain": "", "temSenha": false,
          "encrypt": false, "trustServerCertificate": true },
  "filtros": { "versoes": ["10","19","14"], "zlogPersField1": ["10","19","14","25"], "zlogTenantIds": ["1070"],
               "alarmes": { "incluir": ["In/Out Control", "..."], "excluirCatracas": ["B1", "..."] } }
}
```
`local` = requisição veio de 127.0.0.1/::1. `temDemo` = arquivo de demonstração existe
(o front desabilita a opção "Demonstração" se for `false`). Nunca devolver senha nem hash.

### `POST /api/siport/settings/test`
Corpo: `{ "db": DBFORM }`. Resposta 200 sempre que a requisição é válida:
```json
{ "ok": true, "ms": 120, "servidor": "SRV", "banco": "SIPORTNTACC", "usuario": "leitura",
  "versao": "15.0.2000.5", "agora": "2026-09-29 10:00:00",
  "objetos": [ { "nome": "dbo.SIST_Pers", "ok": true } ],
  "podeLer": true, "podeExecutar": true }
```
Falha de conexão → `{ "ok": false, "erro": "mensagem do driver" }` (status 200).

### `POST /api/siport/settings`
Corpo enviado pelo front:
```json
{
  "db": DBFORM,
  "modo": "sql" | "demo", "refreshMs": 15000, "viradaHora": "6", "horaInicio": "16:00", "nomeLocal": "Nubank Parque",
  "filtros": { "versoes": "10, 19, 14", "zlogPersField1": "10, 19, 14, 25", "zlogTenantIds": "1070",
               "alarmes": { "incluir": "In/Out Control, ...", "excluirCatracas": "B1, ..." } },
  "novaSenhaAdmin": "", "removerSenhaAdmin": false
}

DBFORM = { "autenticacao": "sql" | "windows", "server": "", "instanceName": "", "port": "1433",
           "database": "", "domain": "", "user": "", "password": "",
           "encrypt": false, "trustServerCertificate": true }
```
- Filtros chegam como **texto separado por vírgula** (o backend converte em lista).
- `password` vazio = manter a senha salva. `removerSenhaAdmin` só vale vindo de localhost.
- Resposta: `{ "ok": true, "modo": "sql", "erro": null | "aviso", "settings": { ...igual ao GET... } }`.
  Aplicar sem reiniciar (fechar pool antigo, abrir novo).

## Validação

1. Abrir `/siport` no navegador: a tela tem que ser igual à de referência (topo roxo com
   logo, dia + Início + Ao vivo, abas, KPIs, gráfico, setores, tipos, blocos, feeds).
2. Com `data/siport-demo.json` (chaves `base`/`acessos`/`alarmes`, um objeto por linha com
   os nomes de coluna das views), dia 13/09/2026, Início 00:00:
   36.307 válidos, 22.578 lidos, 22.639 passagens, 1.381 alarmes, última leitura 22:43.
3. Consulta `01156715112600` → LIDO 20:45:25 na PREMB 8, perfis FANZ e G020, 2 alarmes
   "Perfil sem acesso" (PISA 14, INFA 6). Consulta `501023428171209954372102` → ingresso `01023428171202`.
4. Aba Alarmes com "só quem não entrou depois" marcado → 283 alarmes.
5. Aba Configuração: carregar, Testar conexão, Salvar — sem erro no console.
6. Nenhuma outra tela do dashboard mudou.
