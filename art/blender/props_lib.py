"""
Shared toolkit for the gameplay props (props.py): mesh builders, a small shader-node kit,
2D decal rendering and a high -> low atlas baker.

Why not common.bake? It bakes base color with Cycles' DIFFUSE/COLOR pass, which is black for
metallic surfaces (Cycles multiplies diffuse color by 1 - metallic), and it has no metallic
output. Props are half metal (brass, chrome, steel), so `bake_atlas` here bakes every channel
through an emission rewire instead: base color, an ORM-packed roughness/metallic image and a
tangent-space normal map (from the high-poly's geometry + shader bump).

Environment knobs (for iterating, never for final assets):
  PROPS_FAST=1     half-size bakes and fewer samples
"""

from __future__ import annotations

import math
import os
import tempfile
from typing import Callable, Iterable, Sequence

import bpy
import bmesh
from mathutils import Matrix, Vector

import common

FAST = os.environ.get('PROPS_FAST') == '1'
TMP = os.path.join(tempfile.gettempdir(), 'mute-props')

FONT_PATHS = {
    'sans_bold': ['/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf',
                  '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
                  '/usr/share/fonts/truetype/freefont/FreeSansBold.ttf'],
    'sans': ['/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf',
             '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'],
    'serif_bold': ['/usr/share/fonts/truetype/liberation/LiberationSerif-Bold.ttf',
                   '/usr/share/fonts/truetype/dejavu/DejaVuSerif-Bold.ttf'],
    'serif': ['/usr/share/fonts/truetype/liberation/LiberationSerif-Regular.ttf',
              '/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf'],
    'mono_bold': ['/usr/share/fonts/truetype/liberation/LiberationMono-Bold.ttf',
                  '/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf'],
}


def build() -> None:
    """art/build.py imports every module here and calls build(); this one is only a helper."""


def tex_size(n: int) -> int:
    return max(128, n // 2) if FAST else n


def samples(n: int) -> int:
    return max(4, n // 3) if FAST else n


# ---------------------------------------------------------------------------------------------
# Mesh building
# ---------------------------------------------------------------------------------------------

def link(obj: bpy.types.Object) -> bpy.types.Object:
    bpy.context.scene.collection.objects.link(obj)
    return obj


def from_bmesh(name: str, bm: bmesh.types.BMesh) -> bpy.types.Object:
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    return link(bpy.data.objects.new(name, me))


def xform(obj: bpy.types.Object, loc=(0, 0, 0), rot=(0, 0, 0), scale=(1, 1, 1)) -> bpy.types.Object:
    """Bake a transform into the mesh data (all props keep identity object transforms)."""
    m = Matrix.Translation(Vector(loc)) @ _euler(rot).to_matrix().to_4x4() @ Matrix.Diagonal((*scale, 1))
    obj.data.transform(m)
    obj.data.update()
    return obj


def _euler(rot):
    from mathutils import Euler
    return Euler([math.radians(a) for a in rot], 'XYZ')


def box(name: str, size, loc=(0, 0, 0), rot=(0, 0, 0)) -> bpy.types.Object:
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    for v in bm.verts:
        v.co = Vector((v.co.x * size[0], v.co.y * size[1], v.co.z * size[2]))
    o = from_bmesh(name, bm)
    return xform(o, loc, rot)


def rounded_box(name: str, size, loc=(0, 0, 0), r_vert: float = 0.0, r_edge: float = 0.0, segs_vert: int = 3,
                segs_edge: int = 1, axis: str = 'Z', rot=(0, 0, 0)) -> bpy.types.Object:
    """Box with a bigger radius on the 4 edges parallel to `axis` and a small bevel elsewhere."""
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    for v in bm.verts:
        v.co = Vector((v.co.x * size[0], v.co.y * size[1], v.co.z * size[2]))
    ax = Vector({'X': (1, 0, 0), 'Y': (0, 1, 0), 'Z': (0, 0, 1)}[axis])
    if r_vert > 0:
        es = [e for e in bm.edges if abs((e.verts[1].co - e.verts[0].co).normalized().dot(ax)) > 0.99]
        bmesh.ops.bevel(bm, geom=es, offset=r_vert, segments=segs_vert, profile=0.5, affect='EDGES',
                        clamp_overlap=True)
    if r_edge > 0:
        es = [e for e in bm.edges if len(e.link_faces) == 2 and e.calc_face_angle(0) > math.radians(40)]
        bmesh.ops.bevel(bm, geom=es, offset=r_edge, segments=segs_edge, profile=0.5, affect='EDGES',
                        clamp_overlap=True)
    o = from_bmesh(name, bm)
    xform(o, loc, rot)
    smooth_by_angle(o, 50)
    return o


def frame(name: str, outer, inner, depth: float, loc=(0, 0, 0), rot=(0, 0, 0), bevel_w: float = 0.0,
          bevel_segs: int = 1, back: bool = True) -> bpy.types.Object:
    """Rectangular ring (bezel) in the XY plane, extruded along +Z (from 0 to depth), then
    transformed. outer/inner = (w, h)."""
    bm = bmesh.new()
    ow, oh = outer[0] / 2, outer[1] / 2
    iw, ih = inner[0] / 2, inner[1] / 2
    oc = [(-ow, -oh), (ow, -oh), (ow, oh), (-ow, oh)]
    ic = [(-iw, -ih), (iw, -ih), (iw, ih), (-iw, ih)]
    of = [bm.verts.new((x, y, depth)) for x, y in oc]
    inf = [bm.verts.new((x, y, depth)) for x, y in ic]
    ob = [bm.verts.new((x, y, 0)) for x, y in oc]
    ib = [bm.verts.new((x, y, 0)) for x, y in ic]
    for i in range(4):
        j = (i + 1) % 4
        bm.faces.new((of[i], of[j], inf[j], inf[i]))
        bm.faces.new((ob[j], of[j], of[i], ob[i]))
        bm.faces.new((inf[i], inf[j], ib[j], ib[i]))
        if back:
            bm.faces.new((ib[i], ib[j], ob[j], ob[i]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    if bevel_w > 0:
        es = [e for e in bm.edges if len(e.link_faces) == 2 and e.calc_face_angle(0) > math.radians(40)
              and not (back is False and any(v.co.z < 1e-6 for v in e.verts))]
        es = [e for e in es if not all(v.co.z < 1e-6 for v in e.verts)]
        bmesh.ops.bevel(bm, geom=es, offset=bevel_w, segments=bevel_segs, profile=0.5, affect='EDGES',
                        clamp_overlap=True)
    o = from_bmesh(name, bm)
    xform(o, loc, rot)
    smooth_by_angle(o, 50)
    return o


def triangulate(obj: bpy.types.Object) -> bpy.types.Object:
    """Triangulate (keeping custom normals) so the bake's tangent space matches the export."""
    m = obj.modifiers.new('tri', 'TRIANGULATE')
    m.quad_method = 'BEAUTY'
    m.ngon_method = 'BEAUTY'
    m.keep_custom_normals = True
    m.min_vertices = 4
    common.apply_modifiers(obj)
    return obj


def weighted_normals(obj: bpy.types.Object, weight: int = 50) -> bpy.types.Object:
    """Face-area weighted custom normals: flat faces stay flat, bevels carry the shading."""
    for p in obj.data.polygons:
        p.use_smooth = True
    m = obj.modifiers.new('wn', 'WEIGHTED_NORMAL')
    m.mode = 'FACE_AREA'
    m.weight = weight
    m.keep_sharp = True
    common.apply_modifiers(obj)
    return obj


def lathe(name: str, profile: Sequence[tuple[float, float]], segs: int, loc=(0, 0, 0), rot=(0, 0, 0),
          angle: float = 360.0, start: float = 0.0, smooth_deg: float | None = 35.0) -> bpy.types.Object:
    """
    Revolve a (radius, z) profile around Z. Points with radius 0 collapse to a single vertex
    (closed caps). Profile order sets the normals: they point to the right of the walking
    direction in the (r ->, z ^) half-plane, so walk a solid bottom-center -> out -> up -> axis.
    """
    bm = bmesh.new()
    full = abs(angle - 360.0) < 1e-6
    n = segs if full else segs + 1
    rings = []
    for r, z in profile:
        if r <= 1e-9:
            rings.append([bm.verts.new((0, 0, z))])
            continue
        ring = []
        for i in range(n):
            a = math.radians(start + angle * i / segs)
            ring.append(bm.verts.new((r * math.cos(a), r * math.sin(a), z)))
        rings.append(ring)
    for k in range(len(rings) - 1):
        a, b = rings[k], rings[k + 1]
        steps = segs
        for i in range(steps):
            i2 = (i + 1) % n if full else i + 1
            if len(a) == 1 and len(b) == 1:
                continue
            # Winding gives normal = tangent x profile-direction: on the right of the walking
            # direction in the (r ->, z ^) half-plane (outward for a solid walked bottom-up).
            if len(a) == 1:
                bm.faces.new((a[0], b[i2], b[i]))
            elif len(b) == 1:
                bm.faces.new((a[i], a[i2], b[0]))
            else:
                bm.faces.new((a[i], a[i2], b[i2], b[i]))
    o = from_bmesh(name, bm)
    xform(o, loc, rot)
    if smooth_deg is not None:
        smooth_by_angle(o, smooth_deg)
    return o


def sweep(name: str, path: Sequence, radius: float | Sequence[float], sides: int = 8, closed: bool = False,
          caps: bool = True, smooth_deg: float | None = 60.0) -> bpy.types.Object:
    """A tube along a polyline (parallel-transported frames). `radius` may vary per point."""
    pts = [Vector(p) for p in path]
    radii = list(radius) if isinstance(radius, (list, tuple)) else [radius] * len(pts)
    bm = bmesh.new()
    rings = []
    count = len(pts)
    # Initial normal perpendicular to the first tangent.
    t0 = (pts[1] - pts[0]).normalized()
    ref = Vector((0, 0, 1)) if abs(t0.z) < 0.9 else Vector((1, 0, 0))
    nrm = t0.cross(ref).normalized()
    prev_t = t0
    for i, p in enumerate(pts):
        if closed:
            t = (pts[(i + 1) % count] - pts[i - 1]).normalized()
        elif i == 0:
            t = (pts[1] - pts[0]).normalized()
        elif i == count - 1:
            t = (pts[-1] - pts[-2]).normalized()
        else:
            t = ((pts[i + 1] - pts[i]).normalized() + (pts[i] - pts[i - 1]).normalized()).normalized()
        # parallel transport
        axis = prev_t.cross(t)
        if axis.length > 1e-8:
            ang = prev_t.angle(t)
            nrm = Matrix.Rotation(ang, 3, axis.normalized()) @ nrm
        prev_t = t
        bin_ = t.cross(nrm).normalized()
        n2 = bin_.cross(t).normalized()
        ring = []
        for s in range(sides):
            a = 2 * math.pi * s / sides
            ring.append(bm.verts.new(p + (n2 * math.cos(a) + bin_ * math.sin(a)) * radii[i]))
        rings.append(ring)
    segs = count if closed else count - 1
    for k in range(segs):
        a, b = rings[k], rings[(k + 1) % count]
        for s in range(sides):
            bm.faces.new((a[s], a[(s + 1) % sides], b[(s + 1) % sides], b[s]))
    if caps and not closed:
        bm.faces.new(list(reversed(rings[0])))
        bm.faces.new(rings[-1])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    o = from_bmesh(name, bm)
    if smooth_deg is not None:
        smooth_by_angle(o, smooth_deg)
    return o


def prism(name: str, outline: Sequence[tuple[float, float]], depth: float, loc=(0, 0, 0), rot=(0, 0, 0)) -> bpy.types.Object:
    """Extrude a 2D outline (XY, counter-clockwise) along +Z by depth, centered on z=0."""
    bm = bmesh.new()
    lo = [bm.verts.new((x, y, -depth / 2)) for x, y in outline]
    hi = [bm.verts.new((x, y, depth / 2)) for x, y in outline]
    bm.faces.new(list(reversed(lo)))
    bm.faces.new(hi)
    n = len(outline)
    for i in range(n):
        j = (i + 1) % n
        bm.faces.new((lo[i], lo[j], hi[j], hi[i]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    o = from_bmesh(name, bm)
    return xform(o, loc, rot)


def smooth_by_angle(obj: bpy.types.Object, deg: float = 35.0) -> None:
    """Smooth shading + sharp edges above `deg` (mesh-level, no operator context needed)."""
    me = obj.data
    bm = bmesh.new()
    bm.from_mesh(me)
    lim = math.radians(deg)
    for e in bm.edges:
        if len(e.link_faces) == 2:
            e.smooth = e.calc_face_angle(0.0) < lim
        else:
            e.smooth = False
    for f in bm.faces:
        f.smooth = True
    bm.to_mesh(me)
    bm.free()
    me.update()


def flat(obj: bpy.types.Object) -> None:
    for p in obj.data.polygons:
        p.use_smooth = False


def bevel(obj: bpy.types.Object, width: float, segs: int = 1, angle: float = 30.0, harden: bool = True,
          profile: float = 0.5, apply: bool = True, clamp: bool = True, only_vgroup: str | None = None) -> bpy.types.Object:
    """Bevel hard edges (by angle). harden=True gives face-weighted normals (mid-poly look)."""
    for p in obj.data.polygons:
        p.use_smooth = True
    m = obj.modifiers.new('bevel', 'BEVEL')
    m.width = width
    m.segments = segs
    m.limit_method = 'ANGLE' if not only_vgroup else 'VGROUP'
    if only_vgroup:
        m.vertex_group = only_vgroup
    m.angle_limit = math.radians(angle)
    m.profile = profile
    m.use_clamp_overlap = clamp
    m.harden_normals = harden
    m.miter_outer = 'MITER_ARC'
    if apply:
        common.apply_modifiers(obj)
    return obj


def subdivide(obj: bpy.types.Object, levels: int = 1, simple: bool = False) -> bpy.types.Object:
    m = obj.modifiers.new('subd', 'SUBSURF')
    m.levels = levels
    m.render_levels = levels
    if simple:
        m.subdivision_type = 'SIMPLE'
    common.apply_modifiers(obj)
    return obj


def boolean(obj: bpy.types.Object, cutter: bpy.types.Object, op: str = 'DIFFERENCE', remove: bool = True) -> bpy.types.Object:
    m = obj.modifiers.new('bool', 'BOOLEAN')
    m.operation = op
    m.object = cutter
    m.solver = 'EXACT'
    common.apply_modifiers(obj)
    if remove:
        delete(cutter)
    return obj


def solidify(obj: bpy.types.Object, thickness: float, offset: float = -1.0, rim: bool = True) -> bpy.types.Object:
    m = obj.modifiers.new('solid', 'SOLIDIFY')
    m.thickness = thickness
    m.offset = offset
    m.use_rim = rim
    m.use_even_offset = True
    common.apply_modifiers(obj)
    return obj


def delete(obj: bpy.types.Object) -> None:
    data = obj.data
    bpy.data.objects.remove(obj, do_unlink=True)
    if isinstance(data, bpy.types.Mesh) and data.users == 0:
        bpy.data.meshes.remove(data)
    elif isinstance(data, bpy.types.Curve) and data.users == 0:
        bpy.data.curves.remove(data)


def duplicate(obj: bpy.types.Object, name: str | None = None) -> bpy.types.Object:
    o = obj.copy()
    o.data = obj.data.copy()
    o.name = name or obj.name + '_dup'
    link(o)
    return o


def join(objs: Sequence[bpy.types.Object], name: str) -> bpy.types.Object:
    objs = [o for o in objs if o is not None]
    if len(objs) == 1:
        objs[0].name = name
        objs[0].data.name = name
        return objs[0]
    return common.join(objs, name)


def font(kind: str = 'sans_bold'):
    for p in FONT_PATHS.get(kind, []):
        if os.path.exists(p):
            key = os.path.basename(p)
            f = bpy.data.fonts.get(key)
            return f or bpy.data.fonts.load(p)
    return None  # Blender's built-in font


def text(name: str, body: str, size: float, kind: str = 'sans_bold', extrude: float = 0.0,
         align: str = 'CENTER', valign: str = 'CENTER', spacing: float = 1.0, bevel_depth: float = 0.0,
         loc=(0, 0, 0), rot=(0, 0, 0), as_mesh: bool = True) -> bpy.types.Object:
    """Text in the XY plane facing +Z (convert to mesh by default)."""
    cu = bpy.data.curves.new(name, 'FONT')
    cu.body = body
    f = font(kind)
    if f:
        cu.font = f
    cu.size = size
    cu.extrude = extrude
    cu.bevel_depth = bevel_depth
    cu.align_x = align
    cu.align_y = valign
    cu.space_character = spacing
    cu.resolution_u = 3
    o = link(bpy.data.objects.new(name, cu))
    if not as_mesh:
        o.location = loc
        o.rotation_euler = _euler(rot)
        return o
    deps = bpy.context.evaluated_depsgraph_get()
    me = bpy.data.meshes.new_from_object(o.evaluated_get(deps))
    bpy.data.objects.remove(o)
    bpy.data.curves.remove(cu)
    mo = link(bpy.data.objects.new(name, me))
    return xform(mo, loc, rot)


def bend_x_around_z(obj: bpy.types.Object, radius: float, axis_center=(0, 0)) -> bpy.types.Object:
    """Wrap a mesh lying in the XZ plane at y = -radius... onto a cylinder of `radius` around Z.
    x becomes arc length (counter-clockwise seen from +Z), y is the radial offset (+ = outward)."""
    cx, cy = axis_center
    for v in obj.data.vertices:
        x, y, z = v.co
        r = radius + y
        a = x / radius
        v.co = Vector((cx + r * math.sin(a), cy + r * math.cos(a), z))
    obj.data.update()
    return obj


def tag(obj: bpy.types.Object, part: int) -> bpy.types.Object:
    """Integer face attribute 'part' (survives joins) used to split the baked atlas mesh again."""
    me = obj.data
    attr = me.attributes.get('part') or me.attributes.new('part', 'INT', 'FACE')
    for i in range(len(me.polygons)):
        attr.data[i].value = part
    return obj


def split_parts(obj: bpy.types.Object, names: dict[int, str]) -> dict[str, bpy.types.Object]:
    """Split a joined mesh by its 'part' face attribute into separately named objects."""
    out = {}
    for pid, name in names.items():
        o = duplicate(obj, name)
        o.data.name = name
        bm = bmesh.new()
        bm.from_mesh(o.data)
        layer = bm.faces.layers.int.get('part')
        kill = [f for f in bm.faces if f[layer] != pid]
        bmesh.ops.delete(bm, geom=kill, context='FACES')
        loose = [v for v in bm.verts if not v.link_faces]
        bmesh.ops.delete(bm, geom=loose, context='VERTS')
        bm.to_mesh(o.data)
        bm.free()
        o.data.update()
        if 'part' in o.data.attributes:
            o.data.attributes.remove(o.data.attributes['part'])
        out[name] = o
    delete(obj)
    return out


def set_origin(obj: bpy.types.Object, point) -> None:
    """Move obj's origin to `point` (world) without moving the geometry."""
    p = Vector(point)
    obj.data.transform(Matrix.Translation(obj.location - p))
    obj.location = p


def shift_all(objs: Iterable[bpy.types.Object], offset) -> None:
    """Translate geometry of objects (identity transforms) by offset."""
    m = Matrix.Translation(Vector(offset))
    for o in objs:
        if o.type == 'MESH':
            o.data.transform(m)
        else:
            o.location = m @ o.location


def tris(objs: Iterable[bpy.types.Object]) -> int:
    return common.tri_count(list(objs))


def uv_unwrap(objs: Sequence[bpy.types.Object] | bpy.types.Object, margin: float = 0.004, angle: float = 60.0,
              scale_faces: Callable[[bpy.types.MeshPolygon, bpy.types.Object], float] | None = None) -> None:
    """Smart-project, optionally scale some islands (texel density per face), then re-pack."""
    objs = [objs] if isinstance(objs, bpy.types.Object) else list(objs)
    for o in objs:
        # One clean atlas UV layer named UVMap (drop helper layers like 'flat').
        for uvl in list(o.data.uv_layers):
            if uvl.name != 'UVMap':
                o.data.uv_layers.remove(uvl)
        uvl = o.data.uv_layers.get('UVMap') or o.data.uv_layers.new(name='UVMap')
        o.data.uv_layers.active = uvl
        uvl.active_render = True
    common.activate(objs[0], objs)
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.uv.smart_project(angle_limit=math.radians(angle), island_margin=margin, area_weight=0.0,
                             correct_aspect=True, scale_to_bounds=False)
    bpy.ops.object.mode_set(mode='OBJECT')
    if scale_faces:
        for o in objs:
            me = o.data
            uv = me.uv_layers.active.data
            for p in me.polygons:
                s = scale_faces(p, o)
                if s == 1.0:
                    continue
                for li in p.loop_indices:
                    uv[li].uv = uv[li].uv * s
        common.activate(objs[0], objs)
        bpy.ops.object.mode_set(mode='EDIT')
        bpy.ops.mesh.select_all(action='SELECT')
        bpy.ops.uv.select_all(action='SELECT')
        bpy.ops.uv.pack_islands(rotate=True, margin=margin, shape_method='CONCAVE', scale=True)
        bpy.ops.object.mode_set(mode='OBJECT')


# ---------------------------------------------------------------------------------------------
# Shader node kit
# ---------------------------------------------------------------------------------------------

Sock = bpy.types.NodeSocket


class Kit:
    """Tiny helper to write node graphs as expressions. Arguments may be sockets or constants."""

    def __init__(self, mat: bpy.types.Material):
        self.mat = mat
        self.nt = mat.node_tree
        self._x = -2000

    def node(self, kind: str, **props) -> bpy.types.Node:
        n = self.nt.nodes.new(kind)
        n.location = (self._x, 0)
        self._x += 40
        for k, v in props.items():
            setattr(n, k, v)
        return n

    def put(self, sock: bpy.types.NodeSocket, value) -> None:
        if isinstance(value, bpy.types.NodeSocket):
            self.nt.links.new(value, sock)
        elif value is None:
            return
        else:
            if sock.type in ('RGBA',) and isinstance(value, (int, float)):
                value = (value, value, value, 1.0)
            elif sock.type == 'RGBA' and len(value) == 3:
                value = (*value, 1.0)
            elif sock.type == 'VECTOR' and isinstance(value, (int, float)):
                value = (value, value, value)
            sock.default_value = value

    # -- coordinates
    def coord(self, kind: str = 'Object') -> Sock:
        return self.node('ShaderNodeTexCoord').outputs[kind]

    def geo(self, out: str) -> Sock:
        return self.node('ShaderNodeNewGeometry').outputs[out]

    def attr(self, name: str, out: str = 'Fac') -> Sock:
        n = self.node('ShaderNodeAttribute', attribute_name=name)
        return n.outputs[out]

    def xyz(self, vec: Sock) -> tuple[Sock, Sock, Sock]:
        n = self.node('ShaderNodeSeparateXYZ')
        self.put(n.inputs[0], vec)
        return n.outputs[0], n.outputs[1], n.outputs[2]

    def vec(self, x=0.0, y=0.0, z=0.0) -> Sock:
        n = self.node('ShaderNodeCombineXYZ')
        self.put(n.inputs[0], x)
        self.put(n.inputs[1], y)
        self.put(n.inputs[2], z)
        return n.outputs[0]

    def mapping(self, vec: Sock | None = None, loc=(0, 0, 0), rot=(0, 0, 0), scale=(1, 1, 1)) -> Sock:
        n = self.node('ShaderNodeMapping')
        self.put(n.inputs['Vector'], vec if vec is not None else self.coord())
        n.inputs['Location'].default_value = loc
        n.inputs['Rotation'].default_value = [math.radians(a) for a in rot]
        n.inputs['Scale'].default_value = scale
        return n.outputs[0]

    # -- decal mapping (object space; props keep identity transforms so object = world)
    def cyl_uv(self, a0: float, span: float, z0: float, z1: float, center=(0.0, 0.0), axis: str = 'Z') -> Sock:
        """Cylindrical UV: u runs counter-clockwise (seen from +axis) from angle a0 over `span`
        degrees (reads left-to-right from outside), v from z0 to z1 along the axis."""
        x, y, z = self.xyz(self.coord())
        if axis == 'X':
            x, y, z = y, z, x
        elif axis == 'Y':
            x, y, z = z, x, y
        ang = self.math('ARCTAN2', self.sub(y, center[1]), self.sub(x, center[0]))
        t = self.math('FLOORED_MODULO', self.sub(ang, math.radians(a0)), 2 * math.pi)
        u = self.math('DIVIDE', t, math.radians(span))
        v = self.math('DIVIDE', self.sub(z, z0), z1 - z0)
        return self.vec(u, v, 0.0)

    def plane_uv(self, origin, u_axis, v_axis, w: float, h: float) -> Sock:
        """Planar UV centered on `origin`, u along u_axis over width w, v along v_axis over h."""
        p = self.vmath('SUBTRACT', self.coord(), tuple(origin))
        u = self.vmath('DOT_PRODUCT', p, tuple(u_axis), out=1)
        v = self.vmath('DOT_PRODUCT', p, tuple(v_axis), out=1)
        return self.vec(self.add(self.math('DIVIDE', u, w), 0.5), self.add(self.math('DIVIDE', v, h), 0.5), 0.0)

    def polar_uv(self, center, a_axis, b_axis, theta0: float, span: float, r0: float, r1: float) -> Sock:
        """Text around a ring on a plane: theta measured in the (a, b) plane, u runs CLOCKWISE
        from theta0 over `span` degrees (reads left-to-right across the top), v from r0 to r1."""
        p = self.vmath('SUBTRACT', self.coord(), tuple(center))
        a = self.vmath('DOT_PRODUCT', p, tuple(a_axis), out=1)
        b = self.vmath('DOT_PRODUCT', p, tuple(b_axis), out=1)
        th = self.math('ARCTAN2', b, a)
        t = self.math('FLOORED_MODULO', self.sub(math.radians(theta0), th), 2 * math.pi)
        u = self.math('DIVIDE', t, math.radians(span))
        r = self.math('SQRT', self.add(self.mul(a, a), self.mul(b, b)))
        v = self.math('DIVIDE', self.sub(r, r0), r1 - r0)
        return self.vec(u, v, 0.0)

    def box_mask(self, lo, hi, soft: float = 0.0002) -> Sock:
        """1 inside the axis-aligned box [lo, hi] (object space), soft edges."""
        x, y, z = self.xyz(self.coord())
        m = None
        for c, a, b in ((x, lo[0], hi[0]), (y, lo[1], hi[1]), (z, lo[2], hi[2])):
            f = self.mul(self.ramp_f(c, a - soft, a + soft), self.ramp_f(c, b + soft, b - soft))
            m = f if m is None else self.mul(m, f)
        return m

    def knurl(self, axis: str, radius: float, pitch: float = 0.0008, center=(0.0, 0.0)) -> Sock:
        """Diamond knurl height (0..1) on a cylinder around `axis` (X, Y or Z)."""
        x, y, z = self.xyz(self.coord())
        if axis == 'X':
            a, b, w = y, z, x
        elif axis == 'Y':
            a, b, w = z, x, y
        else:
            a, b, w = x, y, z
        ang = self.math('ARCTAN2', self.sub(b, center[1]), self.sub(a, center[0]))
        s = self.mul(ang, radius)
        t1 = self.math('PINGPONG', self.math('DIVIDE', self.add(s, w), pitch), 0.5)
        t2 = self.math('PINGPONG', self.math('DIVIDE', self.sub(s, w), pitch), 0.5)
        return self.mul(self.minf(t1, t2), 2.0)

    def ridges(self, axis: str, count: int, center=(0.0, 0.0)) -> Sock:
        """Straight knurl / coin-edge ridges (0..1) around `axis`."""
        x, y, z = self.xyz(self.coord())
        if axis == 'X':
            a, b = y, z
        elif axis == 'Y':
            a, b = z, x
        else:
            a, b = x, y
        ang = self.math('ARCTAN2', self.sub(b, center[1]), self.sub(a, center[0]))
        return self.mul(self.math('PINGPONG', self.mul(ang, count / math.pi), 0.5), 2.0)

    def decal(self, img: bpy.types.Image, uv: Sock, out: str = 'Color', interp: str = 'Linear') -> Sock:
        return self.image(img, uv, extension='CLIP', interp=interp, out=out)

    # -- textures
    def noise(self, scale=5.0, detail=4.0, rough=0.5, vec=None, distortion=0.0, lac=2.0, out='Fac', dims='3D',
              w: float = 0.0) -> Sock:
        n = self.node('ShaderNodeTexNoise')
        n.noise_dimensions = dims
        if vec is not None:
            self.put(n.inputs['Vector'], vec)
        if dims == '4D':
            self.put(n.inputs['W'], w)
        self.put(n.inputs['Scale'], scale)
        self.put(n.inputs['Detail'], detail)
        self.put(n.inputs['Roughness'], rough)
        self.put(n.inputs['Lacunarity'], lac)
        self.put(n.inputs['Distortion'], distortion)
        return n.outputs[out]

    def voronoi(self, scale=5.0, vec=None, feature='F1', out='Distance', rand=1.0, metric='EUCLIDEAN',
                detail=0.0) -> Sock:
        n = self.node('ShaderNodeTexVoronoi', feature=feature, distance=metric)
        if vec is not None:
            self.put(n.inputs['Vector'], vec)
        self.put(n.inputs['Scale'], scale)
        self.put(n.inputs['Randomness'], rand)
        if 'Detail' in n.inputs:
            self.put(n.inputs['Detail'], detail)
        return n.outputs[out]

    def wave(self, scale=5.0, vec=None, kind='BANDS', direction='X', profile='SIN', distortion=0.0, detail=2.0,
             detail_scale=1.0, out='Fac', phase=0.0) -> Sock:
        n = self.node('ShaderNodeTexWave', wave_type=kind, wave_profile=profile)
        if kind == 'BANDS':
            n.bands_direction = direction
        else:
            n.rings_direction = direction
        if vec is not None:
            self.put(n.inputs['Vector'], vec)
        self.put(n.inputs['Scale'], scale)
        self.put(n.inputs['Distortion'], distortion)
        self.put(n.inputs['Detail'], detail)
        self.put(n.inputs['Detail Scale'], detail_scale)
        self.put(n.inputs['Phase Offset'], phase)
        return n.outputs[out]

    def image(self, img: bpy.types.Image, vec=None, extension='CLIP', interp='Linear', out='Color') -> Sock:
        n = self.node('ShaderNodeTexImage', extension=extension, interpolation=interp)
        n.image = img
        if vec is not None:
            self.put(n.inputs['Vector'], vec)
        return n.outputs[out]

    def image_node(self, img: bpy.types.Image, vec=None, extension='CLIP') -> bpy.types.Node:
        n = self.node('ShaderNodeTexImage', extension=extension)
        n.image = img
        if vec is not None:
            self.put(n.inputs['Vector'], vec)
        return n

    # -- masks
    def ao(self, dist=0.01, inside=False, samples=6, only_local=False) -> Sock:
        n = self.node('ShaderNodeAmbientOcclusion', inside=inside, only_local=only_local, samples=samples)
        n.inputs['Distance'].default_value = dist
        return n.outputs['AO']

    def edges(self, dist=0.003, samples=6, lo=0.55, hi=0.95) -> Sock:
        """Convex-edge mask (1 on edges) from inside-AO."""
        return self.ramp_f(self.ao(dist, inside=True, samples=samples, only_local=True), hi, lo)

    def cavity(self, dist=0.01, samples=6, lo=0.3, hi=0.95) -> Sock:
        """Crevice mask (1 in crevices) from regular AO."""
        return self.ramp_f(self.ao(dist, inside=False, samples=samples), hi, lo)

    # -- math
    def math(self, op: str, a, b=0.0, c=0.0, clamp=False) -> Sock:
        n = self.node('ShaderNodeMath', operation=op, use_clamp=clamp)
        self.put(n.inputs[0], a)
        self.put(n.inputs[1], b)
        self.put(n.inputs[2], c)
        return n.outputs[0]

    def add(self, a, b, clamp=False):
        return self.math('ADD', a, b, clamp=clamp)

    def sub(self, a, b, clamp=False):
        return self.math('SUBTRACT', a, b, clamp=clamp)

    def mul(self, a, b, clamp=False):
        return self.math('MULTIPLY', a, b, clamp=clamp)

    def maxf(self, a, b):
        return self.math('MAXIMUM', a, b)

    def minf(self, a, b):
        return self.math('MINIMUM', a, b)

    def inv(self, a):
        return self.math('SUBTRACT', 1.0, a, clamp=True)

    def ramp_f(self, val, a: float, b: float, c: float = 0.0, d: float = 1.0, interp='SMOOTHSTEP') -> Sock:
        """Map val from [a, b] to [c, d] (clamped, smoothstep by default)."""
        n = self.node('ShaderNodeMapRange', interpolation_type=interp, clamp=True)
        self.put(n.inputs['Value'], val)
        n.inputs['From Min'].default_value = a
        n.inputs['From Max'].default_value = b
        n.inputs['To Min'].default_value = c
        n.inputs['To Max'].default_value = d
        return n.outputs['Result']

    def vmath(self, op: str, a, b=None, out=0) -> Sock:
        n = self.node('ShaderNodeVectorMath', operation=op)
        self.put(n.inputs[0], a)
        if b is not None:
            self.put(n.inputs[1], b)
        return n.outputs[out]

    def mix(self, fac, a, b, blend='MIX', clamp=True) -> Sock:
        """Color mix."""
        n = self.node('ShaderNodeMix', data_type='RGBA', blend_type=blend, clamp_result=clamp)
        self.put(n.inputs[0], fac)
        self.put(n.inputs[6], a)
        self.put(n.inputs[7], b)
        return n.outputs[2]

    def mixf(self, fac, a, b) -> Sock:
        n = self.node('ShaderNodeMix', data_type='FLOAT')
        self.put(n.inputs[0], fac)
        self.put(n.inputs[2], a)
        self.put(n.inputs[3], b)
        return n.outputs[0]

    def ramp(self, fac, stops: Sequence[tuple[float, Sequence[float]]], interp='LINEAR') -> Sock:
        n = self.node('ShaderNodeValToRGB')
        self.put(n.inputs[0], fac)
        cr = n.color_ramp
        cr.interpolation = interp
        while len(cr.elements) > 1:
            cr.elements.remove(cr.elements[-1])
        cr.elements[0].position = stops[0][0]
        cr.elements[0].color = (*stops[0][1], 1.0) if len(stops[0][1]) == 3 else stops[0][1]
        for pos, col in stops[1:]:
            e = cr.elements.new(pos)
            e.color = (*col, 1.0) if len(col) == 3 else col
        return n.outputs['Color']

    def hsv(self, color, h=0.5, s=1.0, v=1.0) -> Sock:
        n = self.node('ShaderNodeHueSaturation')
        self.put(n.inputs['Hue'], h)
        self.put(n.inputs['Saturation'], s)
        self.put(n.inputs['Value'], v)
        self.put(n.inputs['Color'], color)
        return n.outputs[0]

    def bump(self, height, strength=1.0, distance=0.0005, normal=None, invert=False) -> Sock:
        n = self.node('ShaderNodeBump', invert=invert)
        self.put(n.inputs['Height'], height)
        self.put(n.inputs['Strength'], strength)
        self.put(n.inputs['Distance'], distance)
        if normal is not None:
            self.put(n.inputs['Normal'], normal)
        return n.outputs['Normal']

    def scratches(self, scale=60.0, density=0.5, width=0.012, angle=0.0, stretch=40.0, seed=0.0,
                  vec=None) -> Sock:
        """Thin directional scratch lines (1 = scratch)."""
        base = vec if vec is not None else self.coord()
        v = self.mapping(base, loc=(seed * 3.1, seed * 1.7, seed * 2.3), rot=(seed * 37, seed * 53, angle),
                         scale=(1.0, stretch, 1.0))
        # Voronoi edges of a stretched space give long thin lines.
        d = self.voronoi(scale=scale, vec=v, feature='DISTANCE_TO_EDGE')
        line = self.ramp_f(d, width, 0.0)
        # Only keep some of them.
        keep = self.ramp_f(self.noise(scale=scale * 0.08, detail=1.0, vec=v), 1.0 - density * 0.5 - 0.25,
                           1.0 - density * 0.5)
        return self.mul(line, keep)


def pbr(name: str, fn: Callable[[Kit], dict], culling: bool = True, marks: Sequence[dict] | None = None
        ) -> bpy.types.Material:
    """
    Make a procedural material. fn(kit) returns a dict with any of:
      color (RGB socket/tuple), rough, metal (float socket/const), normal (vector socket) OR
      height (float socket) + bump (strength) + bump_dist (meters), emit (RGB), emit_strength.
    `marks` layer decals/masks on top: dicts with mask=callable(kit)->0..1 socket and any of
    color, rough, metal (replace by mask) and height (added, x mask).
    The result is wired into a Principled BSDF (previews + normal bake); bake_atlas rewires it.
    """
    mat = bpy.data.materials.new(name)
    try:
        mat.use_nodes = True
    except Exception:
        pass
    mat.use_backface_culling = culling
    k = Kit(mat)
    ch = fn(k)
    for mk in marks or []:
        m = mk['mask'](k)
        if mk.get('color') is not None:
            c = mk['color'](k) if callable(mk['color']) else mk['color']
            ch['color'] = k.mix(m, ch.get('color', (0.5, 0.5, 0.5)), c)
        if mk.get('rough') is not None:
            ch['rough'] = k.mixf(m, ch.get('rough', 0.5), mk['rough'])
        if mk.get('metal') is not None:
            ch['metal'] = k.mixf(m, ch.get('metal', 0.0), mk['metal'])
        if mk.get('height'):
            ch['height'] = k.add(ch.get('height', 0.0), k.mul(m, mk['height']))
    if 'height' in ch and 'normal' not in ch:
        ch['normal'] = k.bump(ch['height'], strength=ch.get('bump', 0.6), distance=ch.get('bump_dist', 0.0002))
    b = common._bsdf(mat)
    k.put(b.inputs['Base Color'], ch.get('color', (0.5, 0.5, 0.5)))
    k.put(b.inputs['Roughness'], ch.get('rough', 0.5))
    k.put(b.inputs['Metallic'], ch.get('metal', 0.0))
    if 'normal' in ch:
        k.put(b.inputs['Normal'], ch['normal'])
    if 'emit' in ch:
        k.put(b.inputs['Emission Color'], ch['emit'])
        k.put(b.inputs['Emission Strength'], ch.get('emit_strength', 1.0))
    return mat


def flat_material(name: str, color=(0.5, 0.5, 0.5), rough=0.5, metal=0.0, emission=None, emission_strength=1.0,
                  alpha=1.0, culling=True) -> bpy.types.Material:
    m = common.material(name, color=color, roughness=rough, metallic=metal, emission=emission,
                        emission_strength=emission_strength, alpha=alpha)
    m.use_backface_culling = culling
    return m


def assign(obj: bpy.types.Object, mat: bpy.types.Material) -> bpy.types.Object:
    common.assign(obj, mat)
    return obj


# ---------------------------------------------------------------------------------------------
# 2D decals (labels, stencils) rendered to images
# ---------------------------------------------------------------------------------------------

class Decal:
    """
    Compose a flat 2D image from rectangles and text, rendered with Cycles (orthographic, flat
    emission colors) in a throwaway scene. Coordinates in pixels-ish units: (0,0) bottom-left,
    (w,h) top-right. Call render() to get a packed bpy image.
    """

    def __init__(self, name: str, w: int, h: int, bg=(0, 0, 0, 1)):
        self.name, self.w, self.h = name, w, h
        self.scene = bpy.data.scenes.new(f'__decal_{name}')
        self.objs: list[bpy.types.Object] = []
        self.mats: dict[tuple, bpy.types.Material] = {}
        self.z = 0.0
        self.bg = bg

    def _mat(self, rgba) -> bpy.types.Material:
        rgba = tuple(rgba) if len(rgba) == 4 else (*rgba, 1.0)
        if rgba in self.mats:
            return self.mats[rgba]
        m = bpy.data.materials.new(f'__decal_{len(self.mats)}')
        try:
            m.use_nodes = True
        except Exception:
            pass
        nt = m.node_tree
        for n in list(nt.nodes):
            nt.nodes.remove(n)
        out = nt.nodes.new('ShaderNodeOutputMaterial')
        em = nt.nodes.new('ShaderNodeEmission')
        em.inputs['Color'].default_value = (*rgba[:3], 1.0)
        em.inputs['Strength'].default_value = 1.0
        if rgba[3] < 1.0:
            tr = nt.nodes.new('ShaderNodeBsdfTransparent')
            mx = nt.nodes.new('ShaderNodeMixShader')
            mx.inputs[0].default_value = rgba[3]
            nt.links.new(tr.outputs[0], mx.inputs[1])
            nt.links.new(em.outputs[0], mx.inputs[2])
            nt.links.new(mx.outputs[0], out.inputs['Surface'])
        else:
            nt.links.new(em.outputs[0], out.inputs['Surface'])
        self.mats[rgba] = m
        return m

    def _add(self, obj: bpy.types.Object, rgba):
        bpy.context.scene.collection.objects.unlink(obj)
        self.scene.collection.objects.link(obj)
        assign(obj, self._mat(rgba))
        self.z += 0.01
        self.objs.append(obj)
        return obj

    def rect(self, x0, y0, x1, y1, rgba, rot=0.0):
        cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
        o = box('__d_rect', ((x1 - x0), (y1 - y0), 0.001), loc=(cx, cy, self.z), rot=(0, 0, rot))
        return self._add(o, rgba)

    def circle(self, cx, cy, r, rgba, segs=48):
        o = lathe('__d_circ', [(0, 0), (r, 0)], segs, loc=(cx, cy, self.z), smooth_deg=None)
        return self._add(o, rgba)

    def ring(self, cx, cy, r0, r1, rgba, segs=64):
        bm = bmesh.new()
        inner = [bm.verts.new((r0 * math.cos(2 * math.pi * i / segs), r0 * math.sin(2 * math.pi * i / segs), 0)) for i in range(segs)]
        outer = [bm.verts.new((r1 * math.cos(2 * math.pi * i / segs), r1 * math.sin(2 * math.pi * i / segs), 0)) for i in range(segs)]
        for i in range(segs):
            j = (i + 1) % segs
            bm.faces.new((inner[i], outer[i], outer[j], inner[j]))
        o = from_bmesh('__d_ring', bm)
        xform(o, (cx, cy, self.z))
        return self._add(o, rgba)

    def poly(self, pts, rgba):
        bm = bmesh.new()
        vs = [bm.verts.new((x, y, 0)) for x, y in pts]
        bm.faces.new(vs)
        o = from_bmesh('__d_poly', bm)
        xform(o, (0, 0, self.z))
        return self._add(o, rgba)

    def text(self, x, y, body, size, rgba, kind='sans_bold', align='CENTER', valign='CENTER', rot=0.0,
             spacing=1.0, sx=1.0):
        o = text('__d_text', body, size, kind=kind, align=align, valign=valign, spacing=spacing)
        xform(o, (x, y, self.z), (0, 0, rot), (sx, 1, 1))
        return self._add(o, rgba)

    def render(self, aa_samples: int = 16) -> bpy.types.Image:
        sc = self.scene
        sc.render.engine = 'CYCLES'
        sc.cycles.device = 'CPU'
        sc.cycles.samples = aa_samples
        sc.cycles.use_denoising = False
        sc.render.resolution_x = self.w
        sc.render.resolution_y = self.h
        sc.render.resolution_percentage = 100
        sc.render.film_transparent = False
        sc.view_settings.view_transform = 'Standard'
        sc.view_settings.look = 'None'
        sc.render.image_settings.file_format = 'PNG'
        world = bpy.data.worlds.new('__decal_world')
        sc.world = world
        try:
            world.use_nodes = True
        except Exception:
            pass
        bg = next((n for n in world.node_tree.nodes if n.type == 'BACKGROUND'), None)
        if bg:
            bg.inputs['Color'].default_value = self.bg
            bg.inputs['Strength'].default_value = 1.0
        cam_data = bpy.data.cameras.new('__decal_cam')
        cam_data.type = 'ORTHO'
        cam_data.ortho_scale = max(self.w, self.h)
        cam_data.sensor_fit = 'AUTO'
        cam = bpy.data.objects.new('__decal_cam', cam_data)
        cam.location = (self.w / 2, self.h / 2, 100)
        cam_data.clip_end = 1000
        sc.collection.objects.link(cam)
        sc.camera = cam
        os.makedirs(TMP, exist_ok=True)
        path = os.path.join(TMP, f'decal_{self.name}.png')
        sc.render.filepath = path
        bpy.ops.render.render(write_still=True, scene=sc.name)
        for o in list(sc.objects):
            data = o.data
            bpy.data.objects.remove(o, do_unlink=True)
            if isinstance(data, bpy.types.Mesh):
                bpy.data.meshes.remove(data)
        bpy.data.cameras.remove(cam_data)
        bpy.data.scenes.remove(sc)
        bpy.data.worlds.remove(world)
        for m in self.mats.values():
            bpy.data.materials.remove(m)
        img = bpy.data.images.load(path)
        img.name = f'decal_{self.name}'
        img.pack()
        return img


# ---------------------------------------------------------------------------------------------
# Bake: high-poly procedural set -> low-poly atlas (color, ORM, normal [, emission])
# ---------------------------------------------------------------------------------------------

def _principled(mat):
    for n in mat.node_tree.nodes:
        if n.type == 'BSDF_PRINCIPLED':
            return n
    return None


def _output(mat):
    nt = mat.node_tree
    outs = [n for n in nt.nodes if n.type == 'OUTPUT_MATERIAL']
    for n in outs:
        if n.is_active_output:
            return n
    return outs[0] if outs else nt.nodes.new('ShaderNodeOutputMaterial')


def _source(nt, sock):
    """(linked socket or None, default value)."""
    if sock.is_linked:
        return sock.links[0].from_socket, None
    return None, sock.default_value


def _rewire_emission(mats: Iterable[bpy.types.Material], channel: str, metal_scale: float = 1.0):
    """Temporarily route `channel` of each material's Principled BSDF to an Emission output."""
    restore = []
    for mat in mats:
        nt = mat.node_tree
        b = _principled(mat)
        out = _output(mat)
        old = out.inputs['Surface'].links[0].from_socket if out.inputs['Surface'].is_linked else None
        em = nt.nodes.new('ShaderNodeEmission')
        em.inputs['Strength'].default_value = 1.0
        temp = [em]
        if b is None:
            em.inputs['Color'].default_value = (0, 0, 0, 1)
        elif channel == 'color':
            s, v = _source(nt, b.inputs['Base Color'])
            if s:
                nt.links.new(s, em.inputs['Color'])
            else:
                em.inputs['Color'].default_value = v
        elif channel == 'emit':
            s, v = _source(nt, b.inputs['Emission Color'])
            st = b.inputs['Emission Strength'].default_value
            if s:
                nt.links.new(s, em.inputs['Color'])
            else:
                em.inputs['Color'].default_value = v
            em.inputs['Strength'].default_value = st
        elif channel == 'orm':
            comb = nt.nodes.new('ShaderNodeCombineColor')
            temp.append(comb)
            comb.inputs[0].default_value = 1.0
            for idx, name in ((1, 'Roughness'), (2, 'Metallic')):
                s, v = _source(nt, b.inputs[name])
                if name == 'Metallic' and metal_scale != 1.0:
                    mul = nt.nodes.new('ShaderNodeMath')
                    mul.operation = 'MULTIPLY'
                    mul.inputs[1].default_value = metal_scale
                    temp.append(mul)
                    if s:
                        nt.links.new(s, mul.inputs[0])
                    else:
                        mul.inputs[0].default_value = v
                    s = mul.outputs[0]
                if s:
                    nt.links.new(s, comb.inputs[idx])
                else:
                    comb.inputs[idx].default_value = v
            nt.links.new(comb.outputs[0], em.inputs['Color'])
        nt.links.new(em.outputs[0], out.inputs['Surface'])
        restore.append((mat, out, old, temp))
    return restore


def _unwire(restore):
    for mat, out, old, temp in restore:
        nt = mat.node_tree
        for n in temp:
            nt.nodes.remove(n)
        if old is not None:
            nt.links.new(old, out.inputs['Surface'])


def bake_atlas(low: bpy.types.Object, name: str, size: int, highs: Sequence[bpy.types.Object] | None = None,
               samples_: int = 16, extrusion: float = 0.002, max_ray: float = 0.006, margin: int = 6,
               emission: bool = False, normal_strength: float = 1.0, metal_scale: float = 0.8) -> bpy.types.Material:
    """
    Bake `highs` (procedural materials) onto `low` (needs UVs) and give `low` one clean material
    with base color + ORM (roughness G, metallic B) + normal (+ emission) images.
    Without highs, low bakes its own materials.
    metal_scale < 1 keeps some diffuse response on metals: the game has no environment map, so
    fully metallic surfaces would render black everywhere except direct highlights.
    """
    scene = bpy.context.scene
    scene.render.engine = 'CYCLES'
    scene.cycles.samples = samples_
    scene.cycles.use_denoising = False
    scene.render.bake.margin_type = 'EXTEND'
    sel = list(highs) + [low] if highs else [low]
    src_mats = []
    for o in (highs or [low]):
        for m in o.data.materials:
            if m and m not in src_mats:
                src_mats.append(m)

    def new_image(suffix, non_color):
        img = bpy.data.images.new(f'{name}_{suffix}', size, size, alpha=False, float_buffer=False)
        if non_color:
            img.colorspace_settings.name = 'Non-Color'
        return img

    # The low needs its own material carrying the target image node.
    if highs:
        tgt_mat = bpy.data.materials.new(f'{name}__target')
        assign(low, tgt_mat)
        tgt_mats = [tgt_mat]
    else:
        tgt_mats = list(low.data.materials)

    def target(img):
        for mat in tgt_mats:
            nt = mat.node_tree
            node = nt.nodes.get('__bake_target__') or nt.nodes.new('ShaderNodeTexImage')
            node.name = '__bake_target__'
            node.image = img
            for n in nt.nodes:
                n.select = False
            node.select = True
            nt.nodes.active = node

    common_args = dict(margin=margin, use_selected_to_active=bool(highs), use_clear=True)
    if highs:
        common_args.update(cage_extrusion=extrusion, max_ray_distance=max_ray)

    def run(kind, img, **kw):
        target(img)
        common.activate(low, sel)
        bpy.ops.object.bake(type=kind, **common_args, **kw)

    imgs = {}
    for channel, non_color in (('color', False), ('orm', True)) + ((('emit', False),) if emission else ()):
        img = new_image(channel, non_color)
        restore = _rewire_emission(src_mats, channel, metal_scale)
        try:
            run('EMIT', img)
        finally:
            _unwire(restore)
        imgs[channel] = img
    nimg = new_image('normal', True)
    run('NORMAL', nimg, normal_space='TANGENT')
    imgs['normal'] = nimg
    for img in imgs.values():
        img.pack()

    # Final exporter-friendly material.
    mat = bpy.data.materials.new(name)
    try:
        mat.use_nodes = True
    except Exception:
        pass
    mat.use_backface_culling = True
    nt = mat.node_tree
    b = common._bsdf(mat)

    def tex(img, x, y):
        n = nt.nodes.new('ShaderNodeTexImage')
        n.image = img
        n.location = (x, y)
        return n

    nt.links.new(tex(imgs['color'], -700, 300).outputs['Color'], b.inputs['Base Color'])
    sep = nt.nodes.new('ShaderNodeSeparateColor')
    sep.location = (-350, 0)
    nt.links.new(tex(imgs['orm'], -700, 0).outputs['Color'], sep.inputs[0])
    nt.links.new(sep.outputs['Green'], b.inputs['Roughness'])
    nt.links.new(sep.outputs['Blue'], b.inputs['Metallic'])
    nm = nt.nodes.new('ShaderNodeNormalMap')
    nm.location = (-300, -300)
    nm.inputs['Strength'].default_value = normal_strength
    nt.links.new(tex(imgs['normal'], -700, -300).outputs['Color'], nm.inputs['Color'])
    nt.links.new(nm.outputs['Normal'], b.inputs['Normal'])
    if emission:
        nt.links.new(tex(imgs['emit'], -700, -600).outputs['Color'], b.inputs['Emission Color'])
        b.inputs['Emission Strength'].default_value = 1.0
    assign(low, mat)
    for m in tgt_mats:
        if m.users == 0:
            bpy.data.materials.remove(m)
    return mat


def save_images(mat: bpy.types.Material, prefix: str) -> None:
    """Debug: write a material's images to the temp dir for inspection."""
    os.makedirs(TMP, exist_ok=True)
    for n in mat.node_tree.nodes:
        if n.type == 'TEX_IMAGE' and n.image:
            img = n.image
            path = os.path.join(TMP, f'{prefix}_{img.name}.png')
            old = (img.filepath_raw, img.file_format)
            img.filepath_raw = path
            img.file_format = 'PNG'
            img.save()
            img.filepath_raw, img.file_format = old


# ---------------------------------------------------------------------------------------------
# Previews
# ---------------------------------------------------------------------------------------------

def previews(name: str, objs: Sequence[bpy.types.Object], views: Sequence[tuple[str, dict]], final: bool = False,
             frame=None):
    """Studio/flash renders via common.preview. frame=(lo, hi) frames that box instead of the
    meshes' bounds (through an invisible proxy), e.g. to skip a long conduit."""
    s = 56 if final else 24
    meshes = [o for o in objs if o.type == 'MESH']
    proxy = None
    if frame:
        lo, hi = Vector(frame[0]), Vector(frame[1])
        proxy = box('__frame_proxy', tuple(hi - lo), tuple((lo + hi) / 2))
        proxy.hide_render = True
        meshes = [proxy]
    for suffix, kw in views:
        kw = dict(kw)
        kw.setdefault('samples', s)
        for a, b in (('yaw', 'yaw_deg'), ('pitch', 'pitch_deg')):
            if a in kw:
                kw[b] = kw.pop(a)
        common.preview(f'{name}_{suffix}', meshes, **kw)
    if proxy:
        delete(proxy)
