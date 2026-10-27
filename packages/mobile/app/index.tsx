// Standalone Stella runs without the hosted Stella backend.
// Users configure their own Groq API key inside the app.
import StandaloneStella from "../src/components/StandaloneStella";

export default function Index() {
  return <StandaloneStella />;
}
