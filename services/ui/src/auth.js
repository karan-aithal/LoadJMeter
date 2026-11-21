import { createContext, useContext } from 'react';

// Lives outside App.jsx so pages/components can import it without importing App.jsx
// (App.jsx imports the pages, so importing it back created circular imports).
export const AuthContext = createContext(null);
export const useAuth = () => useContext(AuthContext);
