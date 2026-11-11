"""Saludos, agradecimientos y preguntas sobre qué puede hacer el asistente.

Un saludo no es una consulta sobre documentos: buscar evidencia para «hola» solo produce la abstención por falta de
evidencia (o, peor, una llamada al modelo si una palabra suelta coincide). Estas frases se responden con un texto fijo,
sin recuperar, sin llamar al modelo y sin citas. Solo cuenta el mensaje que ES un saludo: «hola, ¿cuál es el plazo de
pago?» sigue su camino normal.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from ragsis_core.text import fold

MAX_WORDS = 8
_NON_ALNUM = re.compile(r"[^a-z0-9ñ]+")
# Palabras de cortesía o vocativos que no cambian la intención («hola equipo», «gracias por favor»).
_FILLER = {"por", "favor", "porfa", "equipo", "asistente", "bot", "amigo", "amiga", "a", "todos", "todas", "ragsis",
           "ragis", "please", "there", "team", "again", "very", "much", "so", "assistant"}

# frase normalizada -> (tipo, idioma)
_PHRASES: dict[str, tuple[str, str]] = {}


def _register(kind: str, lang: str, *phrases: str) -> None:
    for p in phrases:
        _PHRASES[" ".join(_clean(p))] = (kind, lang)


def _clean(text: str) -> list[str]:
    return [w for w in _NON_ALNUM.split(fold(text)) if w and w not in _FILLER]


_register("greeting", "es", "hola", "holi", "ola", "buenas", "buenos dias", "buenas tardes", "buenas noches", "buen dia",
          "saludos", "que tal", "como estas", "como va", "como andas")
_register("greeting", "en", "hello", "hi", "hey", "good morning", "good afternoon", "good evening", "how are you",
          "whats up")
_register("help", "es", "ayuda", "ayudame", "que puedes hacer", "que haces", "que sabes hacer", "que sabes",
          "en que me puedes ayudar", "como me puedes ayudar", "como puedes ayudarme", "como funcionas", "como funciona",
          "quien eres", "que eres")
_register("help", "en", "help", "help me", "what can you do", "what do you do", "how can you help", "how can you help me",
          "how do you work", "who are you", "what are you")
_register("thanks", "es", "gracias", "muchas gracias", "mil gracias", "ok gracias", "vale gracias", "perfecto gracias",
          "listo gracias", "genial gracias")
_register("thanks", "en", "thanks", "thank you", "thanks a lot", "thx", "ok thanks", "great thanks", "perfect thanks")
_register("bye", "es", "adios", "chao", "chau", "hasta luego", "hasta pronto", "nos vemos")
_register("bye", "en", "bye", "goodbye", "see you", "see you later")

_GREETING_PREFIXES = sorted((p for p, (k, _) in _PHRASES.items() if k == "greeting"), key=len, reverse=True)

MESSAGES: dict[tuple[str, str], str] = {
    ("greeting", "es"): "¡Hola! Soy el asistente de documentos de tu espacio de trabajo. Pregúntame lo que necesites saber "
                        "de tus documentos y te responderé con citas a las fuentes.",
    ("help", "es"): "Respondo preguntas usando solo los documentos de este espacio de trabajo a los que tienes acceso, y "
                    "cada respuesta lleva citas a la fuente. Si no encuentro evidencia suficiente, te lo digo en lugar de "
                    "inventar. Prueba con una pregunta concreta: un plazo, un monto, una política o un responsable.",
    ("thanks", "es"): "¡De nada! Si tienes otra pregunta sobre tus documentos, aquí estoy.",
    ("bye", "es"): "¡Hasta luego! Cuando quieras, vuelve a preguntar sobre tus documentos.",
    ("greeting", "en"): "Hello! I'm the document assistant for your workspace. Ask me anything about your documents and "
                        "I'll answer with citations to the sources.",
    ("help", "en"): "I answer questions using only the documents in this workspace that you have access to, and every answer "
                    "cites its source. If I can't find enough evidence I'll say so instead of guessing. Try a specific "
                    "question: a deadline, an amount, a policy or an owner.",
    ("thanks", "en"): "You're welcome! If you have another question about your documents, I'm here.",
    ("bye", "en"): "See you later! Come back anytime to ask about your documents.",
}


@dataclass(frozen=True)
class SmallTalk:
    kind: str       # greeting | help | thanks | bye
    lang: str       # es | en

    @property
    def message(self) -> str:
        return MESSAGES[(self.kind, self.lang)]


def detect(question: str) -> SmallTalk | None:
    """Devuelve el tipo de charla si TODO el mensaje lo es; si trae una pregunta real, devuelve None."""
    words = _clean(question)
    if not words or len(question.split()) > MAX_WORDS:
        return None
    phrase = " ".join(words)
    if phrase in _PHRASES:
        return SmallTalk(*_PHRASES[phrase])
    # «hola, ¿qué puedes hacer?», «buenos días gracias»: un saludo seguido de otra frase de charla.
    for greeting in _GREETING_PREFIXES:
        if phrase.startswith(greeting + " "):
            rest = phrase[len(greeting) + 1:]
            if rest in _PHRASES:
                return SmallTalk(*_PHRASES[rest])
    return None
