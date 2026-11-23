import { Button } from "./components";
import { ThemeProvider } from "./theme";
import { useTheme } from "./theme";

export function App() {
  const theme = useTheme();
  return (
    <ThemeProvider>
      <Button label={theme.name} />
    </ThemeProvider>
  );
}

export default App;
