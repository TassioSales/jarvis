import { useStore } from '../store'
import { LANG_BASE } from '../config'
import './briefing.css'

/**
 * What he can be asked, on one card.
 *
 * A voice interface has no menus, and this one has grown past what anyone
 * would guess: a lock, reminders, notes, a briefing. "Jarvis, ajuda" — or the
 * H key — puts the list on screen. It is a list of things to say, written the
 * way they are said, because a feature nobody knows the words for does not
 * exist.
 */
type Group = { title: string; lines: [string, string][] }

const PT: Group[] = [
  {
    title: 'Chamar e parar',
    lines: [
      ['“Jarvis”', 'acorda; depois diga o pedido'],
      ['“Jarvis, …”', 'pedido direto, de uma vez'],
      ['“Chega” · “Pare”', 'interrompe a fala dele'],
      ['“Jarvis, cancela”', 'interrompe uma pesquisa'],
    ],
  },
  {
    title: 'O dia',
    lines: [
      ['“Bom dia”', 'briefing: clima, e-mail, agenda, mercados, notícias'],
      ['“Como está o tempo?”', 'clima agora e nos próximos dias'],
      ['“Vai chover em novembro?”', 'previsão dos próximos meses'],
      ['“Quais as notícias?”', 'manchetes e quem está noticiando'],
    ],
  },
  {
    title: 'Lembrar e anotar',
    lines: [
      ['“Me lembre às 18h de …”', 'lembrete com hora marcada'],
      ['“Todo dia às 7h, o briefing”', 'rotina diária'],
      ['“Anote: …”', 'salva uma nota em arquivo'],
      ['“Lembre que eu …”', 'guarda um fato sobre você'],
    ],
  },
  {
    title: 'Agir',
    lines: [
      ['“Abra o …”', 'programas e sites, com confirmação'],
      ['“Sim” · “Não”', 'responde quando ele pede confirmação'],
      ['“Bloquear” · “Sou eu”', 'trava e destrava pelo rosto'],
      ['“Cadastrar meu rosto”', 'ensina o seu rosto a ele'],
    ],
  },
]

const EN: Group[] = [
  {
    title: 'Calling and stopping',
    lines: [
      ['“Jarvis”', 'wakes him; then say what you want'],
      ['“Jarvis, …”', 'a request in one breath'],
      ['“Enough” · “Stop”', 'stops him talking'],
      ['“Jarvis, cancel”', 'stops a search'],
    ],
  },
  {
    title: 'The day',
    lines: [
      ['“Good morning”', 'the briefing: weather, mail, calendar, markets, news'],
      ['“How is the weather?”', 'now and for the days ahead'],
      ['“What is in the news?”', 'headlines and who is carrying them'],
    ],
  },
  {
    title: 'Remembering',
    lines: [
      ['“Remind me at six to …”', 'a reminder at a set time'],
      ['“Note: …”', 'saves a note to a file'],
      ['“Remember that I …”', 'keeps a fact about you'],
    ],
  },
  {
    title: 'Acting',
    lines: [
      ['“Open …”', 'programs and sites, with confirmation'],
      ['“Yes” · “No”', 'answers when he asks to proceed'],
      ['“Lock” · “It is me”', 'locks and unlocks by face'],
    ],
  },
]

const KEYS = LANG_BASE === 'pt' ? 'Espaço falar · H ajuda · F rosto · L bloquear · G gestos · V voz · Esc dispensar' : 'Space talk · H help · F face · L lock · G gestures · V voice · Esc dismiss'

export function Help() {
  const help = useStore((s) => s.help)
  if (!help) return null
  const groups = LANG_BASE === 'pt' ? PT : EN

  return (
    <div className="brief help">
      <article className="brief-card help-card">
        <div className="brief-kicker">{LANG_BASE === 'pt' ? 'O QUE DIZER' : 'WHAT TO SAY'}</div>
        <div className="help-grid">
          {groups.map((group) => (
            <section key={group.title}>
              <h3>{group.title}</h3>
              <dl>
                {group.lines.map(([say, does]) => (
                  <div key={say}>
                    <dt>{say}</dt>
                    <dd>{does}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
        <div className="help-keys">{KEYS}</div>
      </article>
    </div>
  )
}
