# Seed media

Two tiny, fully synthetic JPEGs for the fictional client of `npm run seed`. They are generated, not
photographed: there is no real person, place or business in them.

| File | What it is | Command (ffmpeg 9.0.2, generated 2026-10-13) |
|---|---|---|
| `seed-foto-sin-personas.jpg` | SMPTE color bars (`aparecen_personas = false`) | `ffmpeg -f lavfi -i smptebars=s=640x480 -frames:v 1 -q:v 4 seed-foto-sin-personas.jpg` |
| `seed-foto-con-personas.jpg` | a flat dark figure made of boxes on a sky-blue background, standing for "a person" (`aparecen_personas = true`, linked to the seed's fictional authorization) | see below |

```
ffmpeg -f lavfi -i color=c=0x87ceeb:s=640x480 -frames:v 1 -q:v 4 -vf "drawbox=x=280:y=110:w=80:h=80:color=0x333333@1:t=fill,drawbox=x=270:y=200:w=100:h=150:color=0x333333@1:t=fill,drawbox=x=215:y=205:w=50:h=120:color=0x333333@1:t=fill,drawbox=x=375:y=205:w=50:h=120:color=0x333333@1:t=fill,drawbox=x=275:y=355:w=40:h=100:color=0x333333@1:t=fill,drawbox=x=325:y=355:w=40:h=100:color=0x333333@1:t=fill" seed-foto-con-personas.jpg
```

The seed uploads them through `uploadMedia`, so they must stay valid JPEGs: an optional test runs the real
`ffprobe` on both. Do not replace them with photos of real people.
