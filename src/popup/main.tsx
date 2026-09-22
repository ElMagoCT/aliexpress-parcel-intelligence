import { createRoot } from 'react-dom/client';
import '../dashboard/styles.css';
import './popup.css';
import { Popup } from './Popup';

createRoot(document.getElementById('root')!).render(<Popup />);
