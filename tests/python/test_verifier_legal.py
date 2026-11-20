"""Verificador de citas con texto jurídico en español: abreviaturas, etiquetas y negritas.

Casos reales del chat de un bufete: «el num. 4 del art. 93» salía como «el num. 93», y respuestas que empezaban a mitad
de frase («Carlos Camargo Assis** [2]:») porque la etiqueta se partía de su valor.
"""

import pytest
from ragsis_ai.types import Evidence
from ragsis_core.text import split_sentences
from ragsis_rag.verifier import balance_strong, verify

LEGAL = [Evidence(1, "Sentencia C-217 de 2026. Magistrado ponente: Carlos Camargo Assis. Expediente D-16.857. "
                      "El demandante invocó el numeral 4 del art. 93 de la Constitución Política y el Convenio 190 "
                      "de la OIT. Intervino el Dr. Miguel Ángel Rodríguez Rico.", "Sentencia")]


@pytest.mark.parametrize("text,expected", [
    # Abreviaturas jurídicas y de tratamiento: no terminan la oración aunque las siga un número o una mayúscula.
    ("La demanda invocó el num. 4 del art. 93 de la C.P. y el Convenio 190.", 1),
    ("Según el núm. 2 del inc. 3 y el lit. B, aplica el parágrafo.", 1),
    ("Lo firmó el Dr. Pérez y lo revisó la Sra. Gómez.", 1),
    ("Ver fls. 12 a 14 del exp. D-16.857 y la pág. 3.", 1),
    ("Lo radicó J. Calderón ante la Corte.", 1),
    ("El caso es el No. 4 de la lista.", 1),
    # Dos puntos introducen el valor de una etiqueta: es la misma oración.
    ("Magistrado ponente: Carlos Camargo Assis.", 1),
    # Fronteras reales siguen partiendo.
    ("La Corte se inhibió. El demandante puede volver a demandar.", 2),
    ("Se radicó en 2025. La Corte decidió en 2026.", 2),
    ("¿Hay plazo? Sí, hasta el 31 de enero.", 2),
    ("Dijo que no. Después aceptó.", 2),
    ("Multiplica el capital por los meses t. La tasa es fija.", 2),
    ("Aplica el literal b. La Corte lo confirmó.", 2),
])
def test_split_sentences_respects_abbreviations_and_labels(text, expected):
    assert len(split_sentences(text)) == expected, split_sentences(text)


def test_verifier_never_rewrites_legal_references():
    # Antes: «num.» partía la oración, «4 del art.» se descartaba sin cita y quedaba «el num. 93».
    v = verify("La demanda invocó el num. 4 del art. 93 de la Constitución Política [1].", LEGAL)
    assert not v.abstained
    assert "num. 4 del art. 93" in v.answer


def test_verifier_keeps_a_label_with_its_value():
    # Antes: «Magistrado ponente del expediente D-16.857:» se partía de su valor y la respuesta empezaba a mitad.
    v = verify("Magistrado ponente del expediente D-16.857: Carlos Camargo Assis [1].", LEGAL)
    assert v.answer.startswith("Magistrado ponente del expediente D-16.857: Carlos Camargo Assis")


def test_verifier_leaves_no_orphan_bold_markers():
    v = verify("**Expediente D-16.857 ante la Corte Constitucional de Colombia en Bogotá. "
               "Ponente: Carlos Camargo Assis [1].** **Interviniente: el Dr. Miguel Ángel Rodríguez Rico [1].", LEGAL)
    # La negrita abierta en la oración descartada y la abierta sin cierre no deben quedar como «**» sueltos.
    assert v.answer == "Ponente: Carlos Camargo Assis [1]. Interviniente: el Dr. Miguel Ángel Rodríguez Rico [1]."


@pytest.mark.parametrize("text,expected", [
    ("Ponente: Carlos [1].**", "Ponente: Carlos [1]."),
    ("**Plazo: 31 de enero [2].", "Plazo: 31 de enero [2]."),
    ("**Plazo:** 31 de enero [2]. **Riesgo:** inhibición [1].", "**Plazo:** 31 de enero [2]. **Riesgo:** inhibición [1]."),
    ("Uno [1].** **Dos [2].", "Uno [1]. Dos [2]."),
    ("Sin marcas [1].", "Sin marcas [1]."),
])
def test_balance_strong_removes_only_orphan_markers(text, expected):
    assert balance_strong(text) == expected


def test_verifier_keeps_balanced_bold_labels():
    v = verify("**Ponente:** Carlos Camargo Assis [1].", LEGAL)
    assert v.answer == "**Ponente:** Carlos Camargo Assis [1]."
