import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { Satellite, type SatelliteKind } from './ui/Satellite'

// A side monitor is this same page with `?sat=telemetry`, `?sat=world` or `?sat=log`. It gets
// its own root rather than a branch inside App, because App's first act is to
// claim the microphone and the bridge socket, and a second window doing that
// is a second assistant talking over the first.
const sat = new URLSearchParams(location.search).get('sat')
const kind: SatelliteKind | null =
  sat === 'telemetry' || sat === 'world' || sat === 'log' ? sat : null

// Deliberately no StrictMode: its double-invoked effects would open the
// microphone and arm the wake-word engine twice, and the second subscription
// steals the audio stream from the first.
createRoot(document.getElementById('root')!).render(
  kind ? <Satellite kind={kind} /> : <App />,
)
