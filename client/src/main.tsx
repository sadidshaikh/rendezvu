import { lazy, StrictMode, Suspense } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Route, Routes } from 'react-router'
import { Toaster } from 'sonner'
import HomePage from '@/pages/HomePage'
import RoomPage from '@/pages/RoomPage'
import './index.css'

// Loaded on demand: almost nobody opens it, so it stays out of the main bundle.
const TurnCheckPage = lazy(() => import('@/pages/TurnCheckPage'))

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/room/:meetCode" element={<RoomPage />} />
        <Route
          path="/turn-check"
          element={
            <Suspense>
              <TurnCheckPage />
            </Suspense>
          }
        />
      </Routes>
    </BrowserRouter>
    <Toaster position="top-center" />
  </StrictMode>,
)
