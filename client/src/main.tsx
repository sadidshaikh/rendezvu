import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Route, Routes } from 'react-router'
import { Toaster } from 'sonner'
import HomePage from '@/pages/HomePage'
import RoomPage from '@/pages/RoomPage'
import './index.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/room/:meetCode" element={<RoomPage />} />
      </Routes>
    </BrowserRouter>
    <Toaster position="top-center" />
  </StrictMode>,
)
