import { useEffect, useRef, useState } from 'react'
import { useStore } from '../store'
import { cameraStream } from '../lib/camera'
import type { Identity } from '../lib/sync'
import { t } from '../lib/i18n'
import * as sfx from '../lib/sfx'
import { MASTER_PASSWORD } from '../config'
import './lock.css'

const LABEL: Record<Identity, string> = {
  idle: 'awaiting identification',
  scanning: 'verifying identity',
  granted: 'identity confirmed',
  denied: 'access denied',
}

/**
 * The lock itself: concentric rings around a core, the same on every monitor.
 *
 * It carries the whole state in its motion, because across a room the label is
 * unreadable and the rings are not — idling slowly while it waits, spinning up
 * while it looks, opening outward when it lets you in, and stuttering red when
 * it does not. `children` is whatever sits in the core: a padlock on the side
 * monitors, the camera's own picture on the main one.
 */
export function LockRing({
  identity,
  title,
  children,
}: {
  identity: Identity
  title: string
  children?: React.ReactNode
}) {
  return (
    <div className={`lock lock-${identity}`}>
      <svg className="lock-rings" viewBox="-200 -200 400 400" aria-hidden="true">
        <circle className="lock-ring lock-ring-a" r="186" />
        <circle className="lock-ring lock-ring-b" r="164" />
        <circle className="lock-ring lock-ring-c" r="140" />
        <circle className="lock-ring lock-ring-d" r="118" />
      </svg>
      <div className="lock-core">{children}</div>
      <div className="lock-title">{t(title)}</div>
      <div className="lock-label">{t(LABEL[identity])}</div>
    </div>
  )
}

export function Padlock() {
  return (
    <svg className="lock-padlock" viewBox="0 0 24 24" aria-hidden="true">
      <rect x="5" y="10.5" width="14" height="10" rx="1.5" />
      <path d="M8 10.5V7.5a4 4 0 0 1 8 0v3" />
      <circle cx="12" cy="15.5" r="1.3" />
    </svg>
  )
}

/**
 * The lock as the main window shows it.
 *
 * Laid over the interface rather than replacing it, so the reactor is still
 * there behind the veil and unlocking reads as the system coming forward, not
 * as a different screen loading. While he is looking, the core shows what the
 * camera sees. Includes biometric face recognition alongside master password override.
 */
export function Lock() {
  const locked = useStore((s) => s.locked)
  const identity = useStore((s) => s.identity)
  const setLocked = useStore((s) => s.setLocked)
  const setIdentity = useStore((s) => s.setIdentity)
  const fireEffect = useStore((s) => s.fireEffect)
  const video = useRef<HTMLVideoElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const [passcode, setPasscode] = useState('')
  const [errorMsg, setErrorMsg] = useState('')
  const [isVerifying, setIsVerifying] = useState(false)

  useEffect(() => {
    if (identity !== 'scanning') return
    // The stream opens a moment after the scan is announced, so wait for it
    // rather than assume it is there.
    const poll = setInterval(() => {
      const stream = cameraStream()
      if (stream && video.current && video.current.srcObject !== stream) {
        video.current.srcObject = stream
        void video.current.play().catch(() => {})
      }
    }, 150)
    return () => clearInterval(poll)
  }, [identity])

  useEffect(() => {
    if (locked) {
      setErrorMsg('')
      setPasscode('')
      // Give focus to the password field when locked
      const timer = setTimeout(() => inputRef.current?.focus(), 150)
      return () => clearTimeout(timer)
    }
  }, [locked])

  if (!locked && identity === 'idle') return null

  const handleUnlock = (e?: React.FormEvent) => {
    e?.preventDefault()
    if (isVerifying) return

    const clean = passcode.trim()
    const target = (MASTER_PASSWORD || '*Tl250502').trim()

    // Accept exact match or stripped match (*Tl250502 or Tl250502)
    if (
      clean === target ||
      clean === target.replace(/^\*/, '') ||
      clean === `*${target}`
    ) {
      setIsVerifying(true)
      setErrorMsg('')
      setIdentity('granted')
      fireEffect('scan')
      sfx.play('done')
      setTimeout(() => {
        setLocked(false)
        setIdentity('idle')
        setIsVerifying(false)
        setPasscode('')
      }, 900)
    } else {
      setErrorMsg('ACESSO NEGADO // SENHA INCORRETA')
      setIdentity('denied')
      fireEffect('glitch')
      sfx.play('error')
      setTimeout(() => {
        setIdentity('idle')
        setErrorMsg('')
      }, 1800)
    }
  }

  return (
    <div className="lock-veil">
      <div className="lock-container">
        <LockRing identity={identity} title="Command Centre">
          {identity === 'scanning' ? (
            <video ref={video} className="lock-camera" muted playsInline />
          ) : (
            <Padlock />
          )}
        </LockRing>

        {locked && (
          <form onSubmit={handleUnlock} className="lock-pass-box">
            <div className="lock-pass-header">
              <span className="lock-pass-tag">STARK SECURITY OVERRIDE</span>
              <span className="lock-pass-sub">AUTENTICAÇÃO POR SENHA</span>
            </div>
            <div className="lock-pass-input-row">
              <input
                ref={inputRef}
                type="password"
                className="lock-pass-input"
                placeholder="Digite a senha..."
                value={passcode}
                onChange={(e) => {
                  setPasscode(e.target.value)
                  if (errorMsg) setErrorMsg('')
                }}
                autoComplete="off"
                spellCheck={false}
              />
              <button type="submit" className="lock-pass-btn">
                DESBLOQUEAR
              </button>
            </div>
            {errorMsg ? (
              <div className="lock-pass-error">{errorMsg}</div>
            ) : (
              <div className="lock-pass-hint">Pressione Enter ou clique para validar</div>
            )}
          </form>
        )}
      </div>
    </div>
  )
}
