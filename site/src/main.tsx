import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { AgentAvatar } from '../../brand/agent-avatar'
import '../../brand/agent-avatar.css'
import BRAND from '../../brand/product.json'
import prompt from '../../docs/SETUP-PROMPT.txt?raw'
import prep from '../../docs/BEFORE-YOU-START.md?raw'
import { computers, initialState, transition } from './fixtures'
import '../../apps/desktop/src/app/bot-product/shell.css'
import './style.css'

function CopyPrompt() {
  const [copied, setCopied] = useState(false),
    [fallback, setFallback] = useState(false)
  return (
    <div className="copy-control">
      <button
        className="button primary"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(prompt)
            setCopied(true)
          } catch {
            setFallback(true)
          }
        }}
      >
        {copied ? 'Copied — ready for your assistant' : 'Copy setup prompt'} <span aria-hidden="true">↗</span>
      </button>
      <span role="status">{copied ? 'Paste into Claude Code or Codex.' : ''}</span>
      {fallback && (
        <label>
          Copy this installation request
          <textarea readOnly value={prompt} onFocus={e => e.currentTarget.select()} />
        </label>
      )}
    </div>
  )
}
function Header() {
  return (
    <header className="site-header">
      <a href="/" className="wordmark">
        <img src="/favicon.svg" alt="" />
        <span>
          {BRAND.name}
          <small>{BRAND.byline}</small>
        </span>
      </a>
      <nav aria-label="Main navigation">
        <a href="/demo">Demo</a>
        <a href="/prep">Before you start</a>
        <a className="nav-build" href="/build">
          Build your own <span aria-hidden="true">↗</span>
        </a>
      </nav>
    </header>
  )
}
function Footer() {
  return (
    <footer>
      <a href="/">
        {BRAND.name}
        <span> {BRAND.byline}</span>
      </a>
      <div>
        <a href={BRAND.repository}>GitHub</a>
        <a href={BRAND.repository + '/blob/main/PRIVACY.md'}>Privacy</a>
        <a href={BRAND.repository + '/blob/main/LICENSE'}>MIT license</a>
        <span>v{BRAND.version} · beta</span>
      </div>
    </footer>
  )
}
function Demo({ preview = false }: { preview?: boolean }) {
  const [state, setState] = useState({ ...initialState }),
    [step, setStep] = useState(0)
  const c = computers[state.selected]
  const act = (action: string, value?: number) => setState(s => transition(s, action, value))
  return (
    <section className={'demo bot-product-shell ' + (preview ? 'preview' : '')} aria-label="Simulated Studio workspace">
      <div className="demo-banner">
        <span>
          <i /> INTERACTIVE EXAMPLE <b>Sample data · no credits used</b>
        </span>
        <button
          onClick={() => {
            act('reset')
            setStep(0)
          }}
        >
          Reset demo ↺
        </button>
      </div>
      <div className="demo-grid">
        <aside className="demo-rail">
          <p className="eyebrow">
            YOUR COMPUTERS <span>04</span>
          </p>
          {computers.map((a, i) => (
            <button
              key={a.id}
              className={'computer ' + (state.selected === i ? 'selected' : '')}
              onClick={() => act('select', i)}
              aria-pressed={state.selected === i}
            >
              <AgentAvatar name={a.name} identity={a.name} head={a.name === 'AI Co-founder'} />
              <span>
                {a.name}
                <small>Sample workspace</small>
              </span>
              <i />
            </button>
          ))}
          <div className="rail-bottom">
            <span className="permission-dot" /> Private by design
            <p>Each computer keeps its own agents, history and files.</p>
          </div>
        </aside>
        <div className="demo-center">
          <div className="workspace-header">
            <AgentAvatar name={c.name} identity={c.name} head={c.name === 'AI Co-founder'} />
            <div>
              <h2>{c.name}</h2>
              <p>Hermes profile · {c.name}</p>
            </div>
            <span className="sample-label">SAMPLE</span>
          </div>
          <div className="workspace-tabs" role="group" aria-label="Workspace section">
            {(['chat', 'profile', 'skills'] as const).map(tab => (
              <button key={tab} aria-pressed={state.tab === tab} onClick={() => setState(s => ({ ...s, tab }))}>
                {tab === 'chat' ? 'Conversation' : tab === 'profile' ? 'Profile & memory' : 'Skills'}
              </button>
            ))}
          </div>
          <div className="conversation" aria-live="polite" aria-atomic="false">
            {state.tab === 'chat' ? (
              <>
                <p className="sample-time">EXAMPLE CONVERSATION</p>
                <div className="message human">
                  <span>YOU</span>
                  <p>{c.task}</p>
                </div>
                <div className="message assistant">
                  <span>
                    {c.name.toUpperCase()} <b>Simulated response</b>
                  </span>
                  <p>{c.reply}</p>
                </div>
                {state.selected === 0 && state.delegated && (
                  <div className="delegation">
                    <span>↗ CROSS-COMPUTER REQUEST</span>
                    <p>Ask Go-to-market to review the positioning. Share the launch brief only.</p>
                    {!state.approved ? (
                      <button className="button" onClick={() => act('approve')}>
                        Approve sample handoff
                      </button>
                    ) : (
                      <>
                        <strong>✓ Sample handoff complete</strong>
                        <p>
                          Go-to-market: “Lead with the work the agents can help finish.” The result is back with your AI
                          Co-founder.
                        </p>
                      </>
                    )}
                  </div>
                )}
              </>
            ) : state.tab === 'profile' ? (
              <div className="profile-detail">
                <p className="eyebrow">PERSISTENT IDENTITY</p>
                <h3>{c.name}</h3>
                <p>{c.role}</p>
                <h4>Memory</h4>
                <p>{c.memory}</p>
                <h4>Computer boundary</h4>
                <p>
                  This profile’s history and working files belong to this computer. Sharing with another computer
                  requires a permitted connection.
                </p>
              </div>
            ) : (
              <div className="profile-detail">
                <p className="eyebrow">PROFILE SKILLS</p>
                <h3>Ready for the work.</h3>
                {c.skills.map(skill => (
                  <div className="skill" key={skill}>
                    <span>{skill}</span>
                    <span>Enabled ✓</span>
                  </div>
                ))}
                <p>
                  These are example skills. In your own installation, manage the skills on the selected Hermes profile.
                </p>
              </div>
            )}
          </div>
          <div className="demo-composer">
            <span>Try a guided action</span>
            <button
              onClick={() => {
                act('select', 0)
                act('delegate')
              }}
            >
              Delegate a task <span aria-hidden="true">↗</span>
            </button>
            <small>Guided demo — no live chat or uploads</small>
          </div>
        </div>
        <aside className={'demo-screen ' + (state.expanded ? 'expanded' : '')} aria-label="Simulated computer screen">
          <div className="screen-header">
            <span>
              <i /> {c.name}’s screen
            </span>
            <button
              aria-label={state.expanded ? 'Collapse screen' : 'Expand screen'}
              onClick={() => setState(s => ({ ...s, expanded: !s.expanded }))}
            >
              {state.expanded ? '↙' : '↗'}
            </button>
          </div>
          <div className="sample-desktop">
            <div className="desktop-top">
              <span>◉</span>
              <span>Sample Linux desktop</span>
              <span>12:00</span>
            </div>
            <div className="editor">
              <div className="editor-top">
                <span>● ● ●</span>
                {c.file}
              </div>
              <div className="editor-content">
                {c.lines.map((line, i) => (
                  <p key={line}>
                    <span>{i + 1}</span>
                    {line}
                  </p>
                ))}
              </div>
              <div className="editor-footer">
                {state.takeover ? 'Automation paused in this example' : 'Agent workspace · simulated'}
              </div>
            </div>
            <p className="screen-watermark">SIMULATED SCREEN</p>
          </div>
          <div className="screen-controls">
            <p>{state.takeover ? 'You have control in this example.' : 'Watch the work, then step in.'}</p>
            <button className="button" onClick={() => act('takeover')}>
              {state.takeover ? 'Resume agent' : 'Take control'}
            </button>
            <small>No remote desktop connection is made.</small>
          </div>
        </aside>
      </div>
      {!preview && (
        <div className="demo-guide">
          <span className="guide-number">0{step + 1}</span>
          <div>
            <strong>
              {
                ['Make yourself at home.', 'Explore a persistent agent.', 'Try a handoff.', 'Step into the screen.'][
                  step
                ]
              }
            </strong>
            <p>
              {
                [
                  'Switch computers on the left. Each opens its own sample conversation and screen.',
                  'Open Profile & memory, then Skills. These stay with the selected computer.',
                  'Choose Delegate a task, then approve the sample request between computers.',
                  'Choose Take control, then Resume agent. Reset whenever you like.'
                ][step]
              }
            </p>
          </div>
          <button onClick={() => setStep((step + 1) % 4)}>{step === 3 ? 'Start again' : 'Next step'} →</button>
        </div>
      )}
    </section>
  )
}
function Home() {
  return (
    <>
      <section className="hero">
        <div>
          <p className="eyebrow">HERMES + ORGO. YOUR OWN WORKSPACE.</p>
          <h1>
            Your agents.
            <br />
            Your computers.
            <br />
            <em>Working together.</em>
          </h1>
          <p className="hero-description">
            Give your AI team a place to work. Talk to your agents, follow their progress, and step into their
            screens—all from one calm workspace.
          </p>
          <div className="actions">
            <a className="button primary" href="/demo">
              Try the demo <span>→</span>
            </a>
            <a className="text-link" href={BRAND.repository}>
              Go to the repo ↗
            </a>
          </div>
          <p className="fine">Free simulated demo. No sign-up. No model credits.</p>
        </div>
        <div className="hero-note">
          <span>01 / YOUR TEAM, IN VIEW</span>
          <p>
            A co-founder.
            <br />A marketer.
            <br />A partner.
            <br />
            <strong>Room to build.</strong>
          </p>
          <a href="/build">Build your own version ↗</a>
        </div>
      </section>
      <div className="demo-caption">
        <span>MEET YOUR WORKSPACE</span>
        <a href="/demo">Open the full demo ↗</a>
      </div>
      <Demo preview />
      <section className="principles">
        <h2>
          One place to see
          <br />
          the work move.
        </h2>
        <div>
          <article>
            <span>01</span>
            <h3>Agents that keep their context.</h3>
            <p>Profiles, skills, memory and conversation history live with Hermes on each computer.</p>
          </article>
          <article>
            <span>02</span>
            <h3>Independent, with permission to collaborate.</h3>
            <p>
              Keep work on its own computer. Use trusted connections when you want agents to hand tasks to each other.
            </p>
          </article>
          <article>
            <span>03</span>
            <h3>You can always step in.</h3>
            <p>Watch a cloud computer inside the workspace. Take control, make a change, and let the agent resume.</p>
          </article>
        </div>
      </section>
      <section className="build-cta">
        <p className="eyebrow">OPEN SOURCE · PRIVATE INSTALLATION</p>
        <h2>Make it yours.</h2>
        <p>
          Bring your Orgo computer and a model provider. Give Claude Code or Codex the repository and let it walk
          through the technical setup with you.
        </p>
        <div className="actions">
          <a className="button primary" href="/build">
            Build your own →
          </a>
          <a href="/prep">See what you’ll need</a>
        </div>
        <p className="fine">Beta software. Your hosting, computer and model usage are billed separately.</p>
      </section>
    </>
  )
}
function Markdown({ text }: { text: string }) {
  const lines = text.split('\n')
  const blocks: React.ReactNode[] = []
  let code = false,
    codeLines: string[] = []
  const inline = (s: string) =>
    s.split(/(\[[^\]]+\]\(https?:\/\/[^)]+\)|\*\*[^*]+\*\*)/).map((part, i) => {
      const link = part.match(/^\[([^\]]+)\]\((https?:\/\/[^)]+)\)$/)
      return link ? (
        <a key={i} href={link[2]}>
          {link[1]}
        </a>
      ) : part.startsWith('**') ? (
        <strong key={i}>{part.slice(2, -2)}</strong>
      ) : (
        part
      )
    })
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]
    if (l.startsWith('```')) {
      if (code) {
        blocks.push(<pre key={i}>{codeLines.join('\n')}</pre>)
        codeLines = []
      }
      code = !code
      continue
    }
    if (code) {
      codeLines.push(l)
      continue
    }
    if (!l.trim() || /^\|[- :|]+\|$/.test(l)) continue
    if (l.startsWith('|')) {
      const rows = []
      while (i < lines.length && lines[i].startsWith('|')) {
        if (!/^\|[- :|]+\|$/.test(lines[i]))
          rows.push(
            lines[i]
              .split('|')
              .slice(1, -1)
              .map(s => s.trim())
          )
        i++
      }
      i--
      blocks.push(
        <div className="table-scroll" key={i}>
          <table>
            <thead>
              <tr>
                {rows[0].map((x, j) => (
                  <th key={j}>{inline(x)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.slice(1).map((r, j) => (
                <tr key={j}>
                  {r.map((x, k) => (
                    <td key={k}>{inline(x)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )
      continue
    }
    if (l.startsWith('# ')) continue
    if (l.startsWith('## ')) {
      blocks.push(<h2 key={i}>{inline(l.slice(3))}</h2>)
      continue
    }
    if (l.startsWith('### ')) {
      blocks.push(<h3 key={i}>{inline(l.slice(4))}</h3>)
      continue
    }
    blocks.push(<p key={i}>{inline(l.replace(/^[-*] /, '• ').replace(/^> /, ''))}</p>)
  }
  return <>{blocks}</>
}
function Prep() {
  return (
    <>
      <section className="page-heading">
        <p className="eyebrow">YOUR PREPARATION PACK</p>
        <h1>Before you start.</h1>
        <p>Accounts, access and costs. Everything in one place before your assistant begins.</p>
        <div className="actions">
          <a className="button primary" href="/downloads/revenue-partner-studio-before-you-start.docx" download>
            Download Word guide ↓
          </a>
          <a className="button" href="/downloads/before-you-start.md" download>
            Markdown ↓
          </a>
        </div>
        <p className="fine">The Word document is ready to import into Google Docs.</p>
      </section>
      <article className="reading">
        <Markdown text={prep} />
        <a className="button primary" href="/build">
          Ready? Build your own →
        </a>
      </article>
    </>
  )
}
function Build() {
  return (
    <>
      <section className="page-heading">
        <p className="eyebrow">FROM THIS REPO TO YOUR WORKSPACE</p>
        <h1>
          Your assistant
          <br />
          handles the setup.
        </h1>
        <p>
          You bring the accounts and approve the costs. Claude Code or Codex installs the software, connects your chosen
          computer, and checks the result.
        </p>
        <CopyPrompt />
      </section>
      <section className="installation">
        <article>
          <span>01</span>
          <div>
            <h2>Have the essentials ready.</h2>
            <p>
              An installation assistant, GitHub access, a Railway account, an Orgo API key and a running Linux computer.
              Start with 8 GB. Choose a supported model subscription or API key for the agents.
            </p>
            <a href="/prep">Read the preparation guide →</a>
          </div>
        </article>
        <article>
          <span>02</span>
          <div>
            <h2>Open Claude Code or Codex.</h2>
            <p>
              Sign in, create an empty project folder, and paste the setup prompt. Your assistant reads the same
              installation procedure in this repository, checks prerequisites and proposes the hosting setup before
              creating paid resources.
            </p>
            <div className="inline-links">
              <a href={BRAND.claudeCode}>Claude Code ↗</a>
              <a href={BRAND.codex}>Codex ↗</a>
              <a href={BRAND.repository}>Repository ↗</a>
            </div>
          </div>
        </article>
        <article>
          <span>03</span>
          <div>
            <h2>Connect your accounts.</h2>
            <p>
              Finish account sign-in and approve your destination computer. The assistant deploys your private workspace
              and reuses the built-in Connect / Repair installer. Keys go into your private installation.
            </p>
            <p className="fine">
              Access to the installation assistant and access to the model running your agents are separate.
            </p>
          </div>
        </article>
        <article>
          <span>04</span>
          <div>
            <h2>Watch a real task work.</h2>
            <p>
              The assistant verifies a conversation, tool use, computer connection, screen takeover and reopening. If
              authentication or a live check is unavailable, it records the blocker and resumes safely later.
            </p>
            <a href={BRAND.repository + '/blob/main/INSTALL.md'}>Read the complete installation procedure →</a>
          </div>
        </article>
      </section>
      <section className="prompt-section" id="setup-prompt">
        <h2>The complete setup request</h2>
        <pre>{prompt}</pre>
        <CopyPrompt />
      </section>
      <section className="release-note">
        <h2>A private beta, ready to explore.</h2>
        <p>
          This release is for your own workspace. It is not a shared multi-tenant SaaS service. The free demo is
          simulated; fresh recipient installation and reliability acceptance are tracked separately from build checks.
        </p>
        <a href={BRAND.repository + '/blob/main/docs/RELEASE-CHECKS.md'}>Supported features & verification status ↗</a>
      </section>
    </>
  )
}
const page = location.pathname.replace(/\/$/, '') || '/'
function App() {
  return (
    <>
      <a href="#main" className="skip">
        Skip to content
      </a>
      <Header />
      <main id="main">
        {page === '/demo' ? (
          <>
            <section className="demo-intro">
              <div>
                <p className="eyebrow">TAKE A LOOK AROUND</p>
                <h1>A team in its element.</h1>
                <p>A guided example of your future workspace. Every response and screen here is simulated.</p>
              </div>
              <a className="button" href="/build">
                Build your own ↗
              </a>
            </section>
            <Demo />
          </>
        ) : page === '/build' ? (
          <Build />
        ) : page === '/prep' ? (
          <Prep />
        ) : page === '/' ? (
          <Home />
        ) : (
          <section className="page-heading">
            <h1>Page not found.</h1>
            <a href="/">Return to Studio →</a>
          </section>
        )}
      </main>
      <Footer />
    </>
  )
}
createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
