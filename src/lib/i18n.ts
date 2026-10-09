import { LANG_BASE } from '../config'

/**
 * The interface's own text, in the configured language.
 *
 * Keyed by the English string so a call site still reads as what it says, and
 * a string with no translation shows in English rather than as a missing-key
 * placeholder — wrong language on screen is a nudge to add a line here, a blank
 * label is a bug. The boot log and the schematic tags are left alone on
 * purpose: they are set dressing, and the films' set dressing is in English.
 */
const PT: Record<string, string> = {
  // Status line
  OFFLINE: 'DESLIGADO',
  INITIALISING: 'INICIALIZANDO',
  'STANDBY — SAY “HEY JARVIS”': 'EM ESPERA — DIGA “JARVIS”',
  ONLINE: 'ATIVO',
  LISTENING: 'OUVINDO',
  PROCESSING: 'PROCESSANDO',
  'ACCESSING SYSTEMS': 'ACESSANDO SISTEMAS',
  RESPONDING: 'RESPONDENDO',

  // Rails and transcript
  SYSTEMS: 'SISTEMAS',
  'none linked': 'nenhum conectado',
  SIGNAL: 'SINAL',
  YOU: 'VOCÊ',
  say: 'diga',
  '“hey jarvis”': '“jarvis”',
  'to talk': 'para falar',
  hands: 'mãos',
  face: 'rosto',
  lock: 'bloquear',
  help: 'ajuda',
  'CAMERA ON · G TO STOP': 'CÂMERA LIGADA · G PARA PARAR',
  LOOKING: 'OLHANDO',

  // Start gate
  INITIALISE: 'INICIAR',
  'click, or clap, to power up': 'clique, ou bata palma, para ligar',

  // Suggestions
  try: 'experimente',
  'what happened in AI this week': 'o que aconteceu em IA esta semana',
  'generate an image of the Mark Seven suit': 'gere uma imagem da armadura Mark Sete',
  'take a screenshot of my phone': 'tire uma captura de tela do meu celular',
  "what's on my calendar tomorrow": 'o que tenho na agenda amanhã',
  'search for the best coffee near me': 'procure o melhor café perto de mim',
  'read me the top story on Hacker News': 'leia a principal notícia do Hacker News',
  'open my GitHub notifications': 'abra minhas notificações do GitHub',
  "summarise what's in my inbox": 'resuma minha caixa de entrada',
  'find me a loading animation': 'encontre uma animação de carregamento',
  "what's the weather looking like": 'como está o tempo',

  // Hand control
  'HAND CONTROL': 'CONTROLE POR GESTOS',
  'grab a blade by its bar': 'pegue um painel pela barra',
  'to stop': 'para parar',

  // The identity lock
  'Command Centre': 'Centro de Comando',
  'awaiting identification': 'aguardando identificação',
  'verifying identity': 'verificando identidade',
  'identity confirmed': 'identidade confirmada',
  'access denied': 'acesso negado',
  'One moment while I confirm your identity.': 'Só um instante enquanto confirmo sua identidade.',
  'Biometric identity confirmed, sir. Systems unlocked.':
    'Identidade biométrica validada, senhor. Sistemas desbloqueados.',
  'I do not recognise you. Access denied.': 'Não o reconheço. Acesso negado.',
  'I cannot see anyone, sir. Systems remain locked.':
    'Não vejo ninguém, senhor. Os sistemas permanecem bloqueados.',
  'The camera is unavailable, sir. Systems remain locked.':
    'A câmera está indisponível, senhor. Os sistemas permanecem bloqueados.',
  'Systems locked, sir.': 'Sistemas bloqueados, senhor.',
  'The systems are already active, sir.': 'Os sistemas já estão ativos, senhor.',
  'There is no face on record, sir. Say: register my face.':
    'Não há rosto cadastrado, senhor. Diga: cadastrar meu rosto.',
  'Look at the camera, sir.': 'Olhe para a câmera, senhor.',
  'Face registered, sir. Say: lock, whenever you want me to stand guard.':
    'Rosto cadastrado, senhor. Diga: bloquear, quando quiser que eu monte guarda.',
  'I could not see your face clearly, sir. Nothing was registered.':
    'Não consegui ver seu rosto com clareza, senhor. Nada foi cadastrado.',

  // The side monitors
  STANDBY: 'EM ESPERA',
  'NO SIGNAL': 'SEM SINAL',
  TELEMETRY: 'PAINEL',
  LOG: 'REGISTRO',
  WORLD: 'MUNDO',
  OVERVIEW: 'PANORAMA',
  'These are the things you can ask me, sir.': 'Estes são os pedidos que o senhor pode me fazer.',
  'Sir, a reminder': 'Senhor, um lembrete',
  'Good morning': 'Bom dia',
  'CONFIRMATION REQUIRED': 'CONFIRMAÇÃO NECESSÁRIA',
  'Shall I proceed, sir?': 'Devo prosseguir, senhor?',
  'say yes': 'diga sim',
  'say no': 'diga não',
  MAIL: 'E-MAIL',
  unread: 'não lidos',
  CALENDAR: 'AGENDA',
  'Nothing needs you': 'Nada pede sua atenção',
  'Calendar clear': 'Agenda livre',
  NEWS: 'NOTÍCIAS',
  MARKETS: 'MERCADOS',
  days: 'dias',
  'voice · calendar · mail · telemetry': 'voz · agenda · e-mails · telemetria',
  MACHINE: 'MÁQUINA',
  MEMORY: 'MEMÓRIA',
  HOST: 'NOME',
  UPTIME: 'LIGADO HÁ',
  MODEL: 'MODELO',
  EFFORT: 'ESFORÇO',
  VOICE: 'VOZ',
  CONVERSATION: 'CONVERSA',
  ACTIVITY: 'ATIVIDADE',
  'nothing said yet': 'nada dito ainda',
  'no tool in use': 'nenhuma ferramenta em uso',
  'nothing remembered yet': 'nada memorizado ainda',
  WEATHER: 'TEMPO',
  'THE WEEK': 'A SEMANA',
  'feels like': 'sensação',
  humidity: 'umidade',
  wind: 'vento',
  today: 'hoje',
  tomorrow: 'amanhã',
  rain: 'chuva',
  'TEMPERATURE · NEXT 24 H': 'TEMPERATURA · PRÓXIMAS 24 H',
  'CHANCE OF RAIN · NEXT 24 H': 'CHANCE DE CHUVA · PRÓXIMAS 24 H',
  'PROCESSOR · LAST 2 MIN': 'PROCESSADOR · ÚLTIMOS 2 MIN',
  HEADLINES: 'MANCHETES',
  outlets: 'veículos',
  'RAIN · MONTHS AHEAD': 'CHUVA · PRÓXIMOS MESES',
  'mm, likely total': 'mm, total provável',
  'no data': 'sem dados',
  'no rain expected': 'sem chuva prevista',
  now: 'agora',
  'min ago': 'min atrás',
  'h ago': 'h atrás',
  'Clear sky': 'Céu limpo',
  'Mostly clear': 'Poucas nuvens',
  'Partly cloudy': 'Parcialmente nublado',
  Overcast: 'Nublado',
  Fog: 'Neblina',
  Drizzle: 'Garoa',
  Rain: 'Chuva',
  'Heavy rain': 'Chuva forte',
  Snow: 'Neve',
  Showers: 'Pancadas de chuva',
  Thunderstorm: 'Tempestade',

  // Errors and the audio self-test
  'Something went wrong.': 'Algo deu errado.',
  'Power-up failed': 'Falha ao ligar',
  'Power-up failed. Click to try again.': 'Falha ao ligar. Clique para tentar de novo.',
  'Bridge connection lost — reconnecting.': 'Conexão com a ponte perdida — reconectando.',
  'Bridge reconnected. The previous conversation was not kept.':
    'Ponte reconectada. A conversa anterior não foi mantida.',
  'Camera access denied — gesture control is unavailable.':
    'Acesso à câmera negado — o controle por gestos está indisponível.',
  'Voice set to': 'Voz definida como',
  'At your service, sir.': 'Às suas ordens, senhor.',
  'Audio test. If you can hear this, speech output is working, sir.':
    'Teste de áudio. Se consegue ouvir isto, a saída de voz está funcionando, senhor.',
}

export const t = (en: string): string => (LANG_BASE === 'pt' ? (PT[en] ?? en) : en)
