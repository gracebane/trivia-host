# Example guest decks for Reilly Birthday Mode

Seven fake guests, real trivia. Filenames are deliberately messy to show what
the name parser copes with. Two are deliberately the wrong length.

| File | Slides | Why it's here |
|---|---|---|
| `Alice.pptx` | 2 | The plain case: question slide, answer slide |
| `bob - trivia.pptx` | 2 | 4:3 deck, red text; scaled onto the 16:9 merged deck |
| `Carol's question.pptx` | 2 | Built on PowerPoint's default title layout, so the text is in placeholders |
| `Dave_Q_final v2.pptx` | 2 | Has a picture on the question slide |
| `eve.pptx` | 2 | Lowercase filename |
| `Frank (one slide).pptx` | **1** | Question and answer on one slide. Collated as a question with no answer slide |
| `Grace question 3 slides.pptx` | **3** | Question, hint, answer. The collate keeps the first and last slide and drops the hint |

Rebuild the merged deck with:

```
python3 scripts/birthday_collate.py scripts/examples/birthday_decks --seed 42 --last eve --out scripts/examples/birthday_decks/collated/reilly_birthday.pptx
```

`collated/` holds that output: the merged `.pptx` and the `.pack.json` the host
app can load instead. Loading either into the host mockup switches it into
Birthday Mode.

Nothing in the app reads the question text. It is in the files so the merged
deck looks like a real one on the TV.
