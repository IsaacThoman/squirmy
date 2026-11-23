"""Build and render Squirmy's googly worm in Blender.

A plush pink worm shaped like an S, with matte googly eyes that look at the
camera, lying on a violet floor. The camera sits close on the head, so the
icon shows the head with the body curving out of frame.

worm-icon is the flattened icon. Its Icon Composer layers are worm-icon-body
(the worm without its eyes) and worm-icon-face (eyes only, with the body held
out so the hidden parts of the eyes stay hidden). Stack them without moving or
resizing. The layers have no floor shadow and no depth of field: Icon Composer
draws its own shadow, and its glass edges turn soft alpha into hard artifacts. worm-mark is worm-icon as a rounded tile on a transparent
background, for the in-app logo and splash screen. worm-mark-bg is a tighter
crop of the head, for favicons. See README.md for the full commands.
"""

import argparse
import math
from pathlib import Path
import re
import sys

import bmesh
import bpy
from mathutils import Vector
import numpy as np

HERE = Path(__file__).resolve().parent
PINK = '#f099d8'      # the dark theme's action colour
VIOLET = '#7c5ce0'    # the focus ring colour; the floor
EYE_WHITE = '#fbf9ff'
PUPIL = '#120e1a'

# The S, drawn on a 120 unit grid (y down) from the head at the top right to the tail.
S_PATH = 'M84 36 C76 22 40 22 40 44 C40 62 80 56 80 78 C80 98 46 100 36 86'
GRID = 1 / 60          # grid units to metres
RADIUS = 15 / 2 * GRID * 1.3


def linear(hex_color):
    hex_color = hex_color.lstrip('#')
    out = []
    for i in (0, 2, 4):
        c = int(hex_color[i:i + 2], 16) / 255
        out.append(c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4)
    return (*out, 1.0)


def link(obj):
    bpy.context.scene.collection.objects.link(obj)
    return obj


# --------------------------------------------------------------------------
# Shape
# --------------------------------------------------------------------------

def svg_points(d, per_segment=40):
    """Points along an SVG path made of M and C commands."""
    points, current = [], None
    for command, args in re.findall(r'([MC])([^MC]*)', d):
        values = [float(v) for v in re.findall(r'-?\d*\.?\d+', args)]
        if command == 'M':
            current = (values[0], values[1])
            continue
        for j in range(0, len(values), 6):
            p1, p2, p3 = values[j:j + 2], values[j + 2:j + 4], values[j + 4:j + 6]
            for k in range(per_segment):
                t = k / per_segment
                u = 1 - t
                points.append(tuple(u ** 3 * current[i] + 3 * u * u * t * p1[i] + 3 * u * t * t * p2[i] + t ** 3 * p3[i]
                                    for i in (0, 1)))
            current = tuple(p3)
    points.append(current)
    return points


def grid_to_world(p, lift):
    return Vector(((p[0] - 60) * GRID, (60 - p[1]) * GRID, lift))


def sphere(name, center, radius, material, axis=None, flatten=1.0):
    mesh = bpy.data.meshes.new(name)
    bm = bmesh.new()
    bmesh.ops.create_uvsphere(bm, u_segments=48, v_segments=24, radius=radius)
    bm.to_mesh(mesh)
    bm.free()
    for poly in mesh.polygons:
        poly.use_smooth = True
    obj = link(bpy.data.objects.new(name, mesh))
    obj.location = center
    if axis is not None:
        obj.rotation_mode = 'QUATERNION'
        obj.rotation_quaternion = Vector(axis).normalized().to_track_quat('Z', 'Y')
        obj.scale = (1, 1, flatten)
    mesh.materials.append(material)
    return obj


def tube(name, points, radius, material):
    """A round tube along the points, thin at the tail and full width from a third of the way."""
    curve = bpy.data.curves.new(name, 'CURVE')
    curve.dimensions = '3D'
    curve.bevel_depth = radius
    curve.bevel_resolution = 10
    curve.use_fill_caps = True
    curve.resolution_u = 4
    spline = curve.splines.new('POLY')
    spline.points.add(len(points) - 1)
    for k, p in enumerate(points):
        t = k / (len(points) - 1)
        spline.points[k].co = (p.x, p.y, p.z, 1)
        spline.points[k].radius = 0.45 + 0.55 * min(1, t / 0.3) ** 0.7
    obj = link(bpy.data.objects.new(name, curve))
    curve.materials.append(material)
    return obj


# --------------------------------------------------------------------------
# Materials and lights
# --------------------------------------------------------------------------

def material(name, color, roughness, sheen=0.0, specular=0.5):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes['Principled BSDF']
    bsdf.inputs['Base Color'].default_value = linear(color)
    bsdf.inputs['Roughness'].default_value = roughness
    bsdf.inputs['Specular IOR Level'].default_value = specular
    if sheen:
        bsdf.inputs['Sheen Weight'].default_value = sheen
        bsdf.inputs['Sheen Roughness'].default_value = 0.4
        bsdf.inputs['Sheen Tint'].default_value = (1, 1, 1, 1)
    return mat


def area(name, location, energy, size, color=(1, 1, 1)):
    data = bpy.data.lights.new(name, 'AREA')
    data.energy = energy
    data.size = size
    data.color = color
    obj = link(bpy.data.objects.new(name, data))
    obj.location = location
    obj.visible_camera = False
    obj.rotation_euler = (-Vector(location)).to_track_quat('-Z', 'Y').to_euler()
    return obj


def setup_scene(samples):
    scene = bpy.context.scene
    scene.render.engine = 'CYCLES'
    try:
        prefs = bpy.context.preferences.addons['cycles'].preferences
        prefs.compute_device_type = 'METAL'
        prefs.get_devices()
        for device in prefs.devices:
            device.use = True
        scene.cycles.device = 'GPU'
    except Exception:
        scene.cycles.device = 'CPU'
    scene.cycles.samples = samples
    scene.cycles.use_adaptive_sampling = True
    scene.cycles.adaptive_threshold = 0.015
    scene.cycles.use_denoising = True
    scene.cycles.max_bounces = 16
    scene.view_settings.view_transform = 'AgX'
    scene.view_settings.look = 'AgX - Punchy'

    # Camera rays see the flat violet backdrop; the lighting sees a dim violet sky.
    world = bpy.data.worlds.new('Squirmy violet')
    scene.world = world
    world.use_nodes = True
    nodes, links = world.node_tree.nodes, world.node_tree.links
    seen = nodes['Background']
    seen.inputs['Color'].default_value = linear(VIOLET)
    seen.inputs['Strength'].default_value = 1.3
    sky = nodes.new('ShaderNodeBackground')
    sky.inputs['Color'].default_value = linear(VIOLET)
    sky.inputs['Strength'].default_value = 0.25
    path = nodes.new('ShaderNodeLightPath')
    mix = nodes.new('ShaderNodeMixShader')
    links.new(path.outputs['Is Camera Ray'], mix.inputs['Fac'])
    links.new(sky.outputs[0], mix.inputs[1])
    links.new(seen.outputs[0], mix.inputs[2])
    links.new(mix.outputs[0], nodes['World Output'].inputs['Surface'])

    scene.render.image_settings.file_format = 'PNG'
    scene.render.image_settings.compression = 90
    return scene


# --------------------------------------------------------------------------
# Face
# --------------------------------------------------------------------------

def googly_eyes(head, radius, forward, camera_location):
    """Two matte googly eyes on top of the head, both looking at the camera."""
    white = material('eye white', EYE_WHITE, 0.85, specular=0.25)
    black = material('pupil', PUPIL, 0.9, specular=0.2)
    forward = Vector((forward.x, forward.y, 0)).normalized()
    side = Vector((-forward.y, forward.x, 0))
    up = Vector((0, 0, 1))
    parts = []
    for i, sign in enumerate((-1, 1)):
        eye_radius = radius * 0.48
        centre = head + forward * radius * 0.3 + side * sign * radius * 0.5 + up * radius * 0.66
        parts.append(sphere(f'eye {i}', centre, eye_radius, white))
        look = ((camera_location - centre).normalized() * 0.85 + forward * 0.15).normalized()
        pupil_radius = eye_radius * 0.52
        parts.append(sphere(f'pupil {i}', centre + look * (eye_radius - pupil_radius * 0.45), pupil_radius, black))
    return parts


# --------------------------------------------------------------------------
# Cameras
# --------------------------------------------------------------------------

def camera(name, location, target, focus, lens, shift=(0.0, 0.0)):
    """A camera aimed like the others, cropped by its lens and lens shift."""
    data = bpy.data.cameras.new(name)
    data.lens = lens
    data.shift_x, data.shift_y = shift
    data.dof.use_dof = True
    data.dof.focus_distance = (location - focus).length
    data.dof.aperture_fstop = 2.2
    data.clip_end = 100
    obj = link(bpy.data.objects.new(name, data))
    obj.location = location
    obj.rotation_euler = (target - location).to_track_quat('-Z', 'Y').to_euler()
    return obj


def rounded_tile(source, destination, radius=0.224):
    """Copy the image with its corners rounded off in the alpha channel, like an app icon."""
    image = bpy.data.images.load(str(source))
    width, height = image.size
    pixels = np.empty(width * height * 4, dtype=np.float32)
    image.pixels.foreach_get(pixels)
    pixels = pixels.reshape(height, width, 4)
    y, x = np.mgrid[0:height, 0:width] + 0.5
    r = radius * width
    # Distance outside the rounded square, with one pixel of antialiasing.
    distance = np.hypot(x - np.clip(x, r, width - r), y - np.clip(y, r, height - r)) - r
    pixels[..., 3] *= np.clip(0.5 - distance, 0, 1)
    tile = bpy.data.images.new('tile', width, height, alpha=True)
    tile.pixels.foreach_set(pixels.ravel())
    tile.filepath_raw = str(destination)
    tile.file_format = 'PNG'
    tile.save()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--size', type=int, default=2048)
    parser.add_argument('--samples', type=int, default=320)
    parser.add_argument('--output', type=Path, default=HERE / 'renders')
    parser.add_argument('--only', default='')
    args = parser.parse_args(sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else [])

    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = setup_scene(args.samples)
    args.output.mkdir(parents=True, exist_ok=True)

    plush = material('plush', PINK, 0.9, sheen=1.0)
    lift = RADIUS * 0.9
    points = [grid_to_world(p, lift) for p in reversed(svg_points(S_PATH))]
    body_parts = [tube('body', points, RADIUS, plush)]
    # Round the tail, and give the head a little more width than the body.
    body_parts.append(sphere('tail', points[0], RADIUS * 0.45, plush))
    head_radius = RADIUS * 1.18
    head = points[-1]
    body_parts.append(sphere('head', head, head_radius, plush))

    floor_mesh = bpy.data.meshes.new('floor')
    floor_mesh.from_pydata([(-40, -40, 0), (40, -40, 0), (40, 40, 0), (-40, 40, 0)], [], [(0, 1, 2, 3)])
    floor = link(bpy.data.objects.new('floor', floor_mesh))
    floor.location.z = -0.02
    floor_mesh.materials.append(material('floor', VIOLET, 0.9, sheen=0.5))

    area('Key', (-3.5, -3.0, 5.5), 1000, 4.5, (1.0, 0.96, 0.92))
    area('Fill', (4.5, -2.0, 3.0), 350, 5, (0.9, 0.9, 1.0))
    area('Rim', (1.0, 4.5, 3.5), 600, 3)

    # The view the icon was chosen from: 34 degrees off vertical, close on the head.
    tilt, distance = math.radians(34), 2.9
    target = head + Vector((-0.05, 0.0, 0.04))
    location = target + Vector((0, -distance * math.sin(tilt), distance * math.cos(tilt)))
    eyes = googly_eyes(head, head_radius, points[-1] - points[-6], location)

    # Crops of that view, made with the lens and its shift so all of them share one perspective.
    icon = camera('Icon camera', location, target, head, 108.8, (0.0475, -0.01625))
    # The same icon with half again as much room, so the Android adaptive icon's safe zone shows the iOS crop.
    android = camera('Android camera', location, target, head, 108.8 / 1.5, (0.0475 / 1.5, -0.01625 / 1.5))
    # The head alone, for favicons.
    mark = camera('Mark camera', location, target, head, 193.4, (0.162, -0.0289))

    renders = {
        'worm-icon': dict(cam=icon),
        'worm-icon-body': dict(cam=icon, transparent=True, floor=False, sharp=True, hide=eyes),
        'worm-icon-face': dict(cam=icon, transparent=True, floor=False, sharp=True, holdout=body_parts),
        # Opaque, floor and all: a shadow caught on transparency comes out darker than the lit floor.
        'worm-android-foreground': dict(cam=android),
        'worm-mark-bg': dict(cam=mark),
    }
    only = {s for s in args.only.split(',') if s}
    figure = body_parts + eyes
    for filename, cfg in renders.items():
        if only and filename not in only:
            continue
        transparent = cfg.get('transparent', False)
        scene.camera = cfg['cam']
        cfg['cam'].data.dof.use_dof = not cfg.get('sharp', False)
        scene.render.film_transparent = transparent
        # The flattened App Store icon must not have an alpha channel.
        scene.render.image_settings.color_mode = 'RGBA' if transparent else 'RGB'
        floor.hide_render = not cfg.get('floor', True)
        for obj in figure:
            obj.hide_render = obj in cfg.get('hide', ())
            obj.is_holdout = obj in cfg.get('holdout', ())
        scene.render.resolution_x = scene.render.resolution_y = args.size
        scene.render.filepath = str((args.output / f'{filename}.png').resolve())
        print(f'Rendering {filename}', flush=True)
        bpy.ops.render.render(write_still=True)

    icon_render = args.output / 'worm-icon.png'
    if (not only or 'worm-mark' in only) and icon_render.exists():
        print('Writing worm-mark', flush=True)
        rounded_tile(icon_render.resolve(), (args.output / 'worm-mark.png').resolve())

    bpy.context.preferences.filepaths.save_version = 0
    bpy.ops.wm.save_as_mainfile(filepath=str(HERE / 'worm.blend'))


if __name__ == '__main__':
    main()
