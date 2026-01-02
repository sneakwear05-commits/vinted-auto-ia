# vinted auto ia (client en main)

Un seul déploiement Render : la PWA + l'API dans le même service.
Ensuite tu ouvres l'URL sur iPhone (Safari) > Partager > Sur l'écran d'accueil.

## Variables Render
- OPENAI_API_KEY (obligatoire pour IA + mannequin)
- (optionnel) TEXT_MODEL (défaut: gpt-5)
- (optionnel) IMAGE_MODEL (défaut: gpt-image-1)

## Endpoints
- GET /api/health
- POST /api/generate-listing
- POST /api/generate-mannequin
