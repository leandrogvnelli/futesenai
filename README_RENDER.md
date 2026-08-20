# FuteSenai para Render

Esta é a versão online do protótipo. O site e o multiplayer passam pela mesma
porta pública do Render. Os computadores da sala precisam apenas de navegador e
internet; não precisam instalar Node.js nem liberar portas locais.

## Publicar

1. Crie um repositório no GitHub e envie o conteúdo desta pasta.
2. No Render, escolha **New > Blueprint** e conecte o repositório.
3. O Render reconhecerá `render.yaml`.
4. Quando solicitado, defina `PROFESSOR_KEY` como uma senha longa que somente o
   professor conheça, sem espaços ou acentos.
5. Aguarde o deploy terminar e abra o endereço `https://...onrender.com`.

## Endereços

- Alunos: `https://SEU-ENDERECO.onrender.com`
- Professor: `https://SEU-ENDERECO.onrender.com/?professor=SUA_CHAVE`

Não compartilhe com os alunos o endereço que contém `?professor=`. Após entrar,
o professor cria a sala normalmente e copia o endereço limpo mostrado no lobby.

Esta versão mantém uma sala ativa por implantação. Ao encerrar a sala, o serviço
continua online e fica pronto para uma nova sala. Como o estado do protótipo fica
em memória, uma reinicialização ou novo deploy encerra a sala atual.

## Plano gratuito

O primeiro acesso após um período sem uso pode demorar cerca de um minuto. Abra
o endereço do professor antes da aula e aguarde a tela carregar.
